import {$} from 'bun'

export interface Thread {
	path: string
	by: string
}

export interface PR {
	repo: string
	number: number
	title: string
	url: string
	isDraft: boolean
	mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
	updatedAt: string
	ci: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | 'NONE'
	additions: number
	deletions: number
	body: string
	approvals: string[]
	changesRequested: string[]
	pendingTeams: string[]
	pendingUsers: string[]
	unresolved: Thread[]
	failedRuns: string[]
	author: string
	myReview: string | null
}

let token: string | undefined
async function getToken(): Promise<string> {
	if (token) return token
	token = (await $`gh auth token`.text()).trim()
	if (!token) throw new Error('gh is not authenticated')
	return token
}

let login: string | undefined
export async function getLogin(): Promise<string> {
	if (login) return login
	login = (await $`gh api user --jq .login`.text()).trim()
	return login
}

const teamCache = new Map<string, string[]>()
export async function getTeams(org: string): Promise<string[]> {
	const cached = teamCache.get(org)
	if (cached) return cached
	const r = await $`gh api user/teams --paginate --jq ${`[.[]|select(.organization.login=="${org}")|.slug]`}`.quiet().nothrow()
	let slugs: string[] = []
	if (r.exitCode === 0) {
		for (const line of r.stdout.toString().trim().split('\n')) {
			try { slugs = slugs.concat(JSON.parse(line) as string[]) } catch { /* ignore */ }
		}
	}
	teamCache.set(org, slugs)
	return slugs
}

const memberCache = new Map<string, Set<string>>()
const MEMBER_CACHE_FILE = `${process.env.HOME}/.cache/prs/team-members.json`
const MEMBER_CACHE_TTL = 24 * 3600 * 1000
let memberCacheDisk: Promise<Record<string, {at: number; members: string[]}>> | undefined
function readMemberCache() {
	memberCacheDisk ??= Bun.file(MEMBER_CACHE_FILE).json().catch(() => ({}))
	return memberCacheDisk
}
export async function getTeamMembers(org: string, slug: string): Promise<Set<string>> {
	const key = `${org}/${slug}`
	const cached = memberCache.get(key)
	if (cached) return cached
	const disk = await readMemberCache()
	const hit = disk[key]
	if (hit && Date.now() - hit.at < MEMBER_CACHE_TTL) {
		const set = new Set(hit.members)
		memberCache.set(key, set)
		return set
	}
	const r = await $`gh api orgs/${org}/teams/${slug}/members --paginate --jq '.[].login'`.quiet().nothrow()
	const members = new Set(r.exitCode === 0 ? r.stdout.toString().split('\n').map(l => l.trim()).filter(Boolean) : [])
	memberCache.set(key, members)
	if (r.exitCode === 0) {
		disk[key] = {at: Date.now(), members: [...members]}
		await Bun.write(MEMBER_CACHE_FILE, JSON.stringify(disk)).catch(() => undefined)
	}
	return members
}

export class RateLimitError extends Error {
	constructor(public readonly resetAt: number) {
		super(`GitHub rate limit exceeded, resets ${new Date(resetAt).toTimeString().slice(0, 8)}`)
	}
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch('https://api.github.com/graphql', {
		method: 'POST',
		headers: {Authorization: `bearer ${await getToken()}`, 'Content-Type': 'application/json'},
		body: JSON.stringify({query, variables}),
	})
	const json = (await res.json()) as {data?: T; errors?: {message: string; type?: string}[]}
	const message = json.errors?.map(e => e.message).join('; ') ?? res.statusText
	if (res.status === 403 || res.status === 429 || json.errors?.some(e => e.type === 'RATE_LIMITED' || /rate limit/i.test(e.message))) {
		const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
		throw new RateLimitError(reset > Date.now() ? reset : Date.now() + 60_000)
	}
	if (!res.ok || json.errors?.length) throw new Error(message)
	return json.data as T
}

const QUERY = `query($q:String!,$after:String){
  search(query:$q,type:ISSUE,first:50,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{ ... on PullRequest {
      number title url isDraft mergeable updatedAt body additions deletions
      author{login}
      repository{nameWithOwner}
      commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{
        ... on CheckRun{conclusion detailsUrl}
        ... on StatusContext{state targetUrl}
      }}}}}}
      reviewRequests(first:20){nodes{requestedReviewer{__typename ... on Team{slug} ... on User{login}}}}
      latestReviews(first:30){nodes{author{login} state}}
      reviewThreads(first:100){nodes{isResolved path comments(first:1){nodes{author{login}}}}}
    }}
  }
}`

type Node = {
	number: number
	title: string
	url: string
	isDraft: boolean
	mergeable: PR['mergeable']
	updatedAt: string
	body: string
	additions: number
	deletions: number
	author: {login: string} | null
	repository: {nameWithOwner: string}
	commits: {nodes: {commit: {statusCheckRollup: {state: PR['ci']; contexts: {nodes: ({conclusion?: string; detailsUrl?: string} | {state?: string; targetUrl?: string})[]}} | null}}[]}
	reviewRequests: {nodes: {requestedReviewer: {__typename: string; slug?: string; login?: string} | null}[]}
	latestReviews: {nodes: {author: {login: string}; state: string}[]}
	reviewThreads: {nodes: {isResolved: boolean; path: string; comments: {nodes: {author: {login: string}}[]}}[]}
}

async function search(q: string, me: string): Promise<PR[]> {
	const out: PR[] = []
	let after: string | null = null
	for (;;) {
		const data: {search: {pageInfo: {hasNextPage: boolean; endCursor: string}; nodes: Node[]}} = await graphql(QUERY, {q, after})
		for (const n of data.search.nodes) {
			if (!n.number) continue
			const rollup = n.commits.nodes[0]?.commit.statusCheckRollup
			const failedRuns = new Set<string>()
			for (const c of rollup?.contexts.nodes ?? []) {
				const failed = 'conclusion' in c ? c.conclusion === 'FAILURE' : c.state === 'FAILURE' || c.state === 'ERROR'
				const url = ('detailsUrl' in c ? c.detailsUrl : c.targetUrl) ?? ''
				const m = failed ? url.match(/\/runs\/(\d+)\//) : null
				if (m) failedRuns.add(m[1])
			}
			out.push({
				repo: n.repository.nameWithOwner,
				number: n.number,
				title: n.title,
				url: n.url,
				isDraft: n.isDraft,
				mergeable: n.mergeable,
				updatedAt: n.updatedAt,
				body: n.body ?? '',
				additions: n.additions,
				deletions: n.deletions,
				ci: rollup?.state ?? 'NONE',
				approvals: n.latestReviews.nodes.filter(r => r.state === 'APPROVED').map(r => r.author.login),
				changesRequested: n.latestReviews.nodes.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.author.login),
				pendingTeams: n.reviewRequests.nodes.flatMap(r => (r.requestedReviewer?.__typename === 'Team' ? [r.requestedReviewer.slug!] : [])),
				pendingUsers: n.reviewRequests.nodes.flatMap(r => (r.requestedReviewer?.__typename === 'User' ? [r.requestedReviewer.login!] : [])),
				unresolved: n.reviewThreads.nodes.filter(t => !t.isResolved).map(t => ({path: t.path, by: t.comments.nodes[0]?.author.login ?? '?'})),
				failedRuns: [...failedRuns],
				author: n.author?.login ?? '?',
				myReview: n.latestReviews.nodes.find(r => r.author.login === me)?.state ?? null,
			})
		}
		if (!data.search.pageInfo.hasNextPage) break
		after = data.search.pageInfo.endCursor
	}
	return out
}

const base = (repos: string[]) => ['is:pr', 'is:open', 'archived:false', ...repos.map(r => `repo:${r}`)]

export async function fetchPRs(repos: string[]): Promise<PR[]> {
	const me = await getLogin()
	return search([...base(repos), 'author:@me'].join(' '), me)
}

export async function fetchForReview(repos: string[]): Promise<PR[]> {
	const me = await getLogin()
	const orgs = [...new Set(repos.map(r => r.split('/')[0]))]
	const [results, teammates] = await Promise.all([
		search([...base(repos), 'review-requested:@me'].join(' '), me),
		Promise.all(orgs.map(async o => Promise.all((await getTeams(o)).map(t => getTeamMembers(o, t)))))
			.then(sets => new Set(sets.flat().flatMap(m => [...m]))),
	])
	return results
		.filter(pr => pr.author !== me && pr.myReview !== 'APPROVED' && !pr.isDraft)
		.filter(pr => !pr.approvals.some(a => teammates.has(a)))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function approve(pr: PR): Promise<string> {
	const r = await $`gh pr review ${pr.number} --repo ${pr.repo} --approve`.quiet().nothrow()
	return r.exitCode === 0 ? `Approved #${pr.number}` : `Approve failed: ${r.stderr.toString().trim().split('\n').pop()}`
}

export async function openInBrowser(pr: PR): Promise<void> {
	await $`open ${pr.url}`.quiet().nothrow()
}

export async function rerunFailed(pr: PR): Promise<string> {
	if (pr.failedRuns.length === 0) return `No failed checks on #${pr.number}`
	const results: string[] = []
	for (const id of pr.failedRuns) {
		const r = await $`gh run rerun ${id} --failed --repo ${pr.repo}`.quiet().nothrow()
		results.push(r.exitCode === 0 ? `run ${id}` : `run ${id} refused: ${r.stderr.toString().trim().split('\n').pop()}`)
	}
	return `Rerunning failed jobs of #${pr.number}: ${results.join(', ')}`
}
