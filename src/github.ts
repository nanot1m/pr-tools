import {$} from 'bun'

export interface Thread {
	path: string
	by: string
	body: string
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
	failedChecks: {name: string; url: string}[]
	failedRuns: string[]
	author: string
	myReview: string | null
	mergeState: string
	inMergeQueue: boolean
	queue: {position: number; state: string; eta: number | null} | null
	autoMerge: boolean
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
	const disk = await readDiskCache()
	const hit = disk[`teams:${org}`]
	if (hit && Date.now() - hit.at < DISK_CACHE_TTL) {
		teamCache.set(org, hit.members)
		return hit.members
	}
	const r = await $`gh api user/teams --paginate --jq ${`[.[]|select(.organization.login=="${org}")|.slug]`}`.quiet().nothrow()
	let slugs: string[] = []
	if (r.exitCode === 0) {
		for (const line of r.stdout.toString().trim().split('\n')) {
			try { slugs = slugs.concat(JSON.parse(line) as string[]) } catch { /* ignore */ }
		}
		await writeDiskCache(`teams:${org}`, slugs)
	}
	teamCache.set(org, slugs)
	return slugs
}

const DISK_CACHE_FILE = `${process.env.HOME}/.cache/prs/github.json`
const DISK_CACHE_TTL = 24 * 3600 * 1000
type DiskCache = Record<string, {at: number; members: string[]}>
let diskCache: Promise<DiskCache> | undefined
function readDiskCache(): Promise<DiskCache> {
	diskCache ??= Bun.file(DISK_CACHE_FILE).json().catch(() => ({}))
	return diskCache
}
async function writeDiskCache(key: string, members: string[]): Promise<void> {
	const disk = await readDiskCache()
	disk[key] = {at: Date.now(), members}
	await Bun.write(DISK_CACHE_FILE, JSON.stringify(disk)).catch(() => undefined)
}

const memberCache = new Map<string, Set<string>>()
export async function getTeamMembers(org: string, slug: string): Promise<Set<string>> {
	const key = `${org}/${slug}`
	const cached = memberCache.get(key)
	if (cached) return cached
	const hit = (await readDiskCache())[key]
	if (hit && Date.now() - hit.at < DISK_CACHE_TTL) {
		const set = new Set(hit.members)
		memberCache.set(key, set)
		return set
	}
	const r = await $`gh api orgs/${org}/teams/${slug}/members --paginate --jq '.[].login'`.quiet().nothrow()
	const members = new Set(r.exitCode === 0 ? r.stdout.toString().split('\n').map(l => l.trim()).filter(Boolean) : [])
	memberCache.set(key, members)
	if (r.exitCode === 0) await writeDiskCache(key, [...members])
	return members
}

export class RateLimitError extends Error {
	constructor(public readonly resetAt: number) {
		super(`GitHub rate limit exceeded, resets ${new Date(resetAt).toTimeString().slice(0, 8)}`)
	}
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	const token = await getToken()
	for (let attempt = 0; ; attempt++) {
		let res: Response
		let text: string
		try {
			res = await fetch('https://api.github.com/graphql', {
				method: 'POST',
				headers: {Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'prs'},
				body: JSON.stringify({query, variables}),
			})
			text = await res.text()
		} catch (e) {
			if (attempt < 3) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue }
			throw new Error(`GitHub unreachable: ${(e as Error).message.split('.')[0]}`)
		}
		let json: {data?: T; errors?: {message: string; type?: string}[]} | null = null
		try { json = JSON.parse(text) } catch { /* non-JSON body, handled below */ }
		if (res.status === 403 || res.status === 429 || json?.errors?.some(e => e.type === 'RATE_LIMITED' || /rate limit/i.test(e.message))) {
			const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
			throw new RateLimitError(reset > Date.now() ? reset : Date.now() + 60_000)
		}
		if (json === null || res.status >= 500) {
			if (attempt < 3) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue }
			throw new Error(`GitHub returned ${res.status} ${res.statusText}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`)
		}
		if (!res.ok || json.errors?.length) throw new Error(json.errors?.map(e => e.message).join('; ') ?? `${res.status} ${res.statusText}`)
		return json.data as T
	}
}

const QUERY = `query($q:String!,$after:String){
  search(query:$q,type:ISSUE,first:50,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{ ... on PullRequest {
      number title url isDraft mergeable updatedAt body additions deletions
      mergeStateStatus isInMergeQueue autoMergeRequest{enabledAt}
      mergeQueueEntry{position state estimatedTimeToMerge}
      author{login}
      repository{nameWithOwner}
      commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      reviewRequests(first:20){nodes{requestedReviewer{__typename ... on Team{slug} ... on User{login}}}}
      latestReviews(first:30){nodes{author{login} state}}
      reviewThreads(first:100){nodes{isResolved path comments(first:1){nodes{author{login} body}}}}
    }}
  }
}`

type Node = {
	number: number
	title: string
	url: string
	isDraft: boolean
	mergeable: PR['mergeable']
	mergeStateStatus: string
	isInMergeQueue: boolean
	mergeQueueEntry: {position: number; state: string; estimatedTimeToMerge: number | null} | null
	autoMergeRequest: {enabledAt: string} | null
	updatedAt: string
	body: string
	additions: number
	deletions: number
	author: {login: string} | null
	repository: {nameWithOwner: string}
	commits: {nodes: {commit: {statusCheckRollup: {state: PR['ci']} | null}}[]}
	reviewRequests: {nodes: {requestedReviewer: {__typename: string; slug?: string; login?: string} | null}[]}
	latestReviews: {nodes: {author: {login: string}; state: string}[]}
	reviewThreads: {nodes: {isResolved: boolean; path: string; comments: {nodes: {author: {login: string}; body: string}[]}}[]}
}

async function search(q: string, me: string): Promise<PR[]> {
	const out: PR[] = []
	let after: string | null = null
	for (;;) {
		const data: {search: {pageInfo: {hasNextPage: boolean; endCursor: string}; nodes: Node[]}} = await graphql(QUERY, {q, after})
		for (const n of data.search.nodes) {
			if (!n.number) continue
			const rollup = n.commits.nodes[0]?.commit.statusCheckRollup
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
				unresolved: n.reviewThreads.nodes.filter(t => !t.isResolved).map(t => ({path: t.path, by: t.comments.nodes[0]?.author.login ?? '?', body: t.comments.nodes[0]?.body ?? ''})),
				failedChecks: [],
				failedRuns: [],
				author: n.author?.login ?? '?',
				myReview: n.latestReviews.nodes.find(r => r.author.login === me)?.state ?? null,
				mergeState: n.mergeStateStatus,
				inMergeQueue: n.isInMergeQueue,
				queue: n.mergeQueueEntry ? {position: n.mergeQueueEntry.position, state: n.mergeQueueEntry.state, eta: n.mergeQueueEntry.estimatedTimeToMerge} : null,
				autoMerge: n.autoMergeRequest !== null,
			})
		}
		if (!data.search.pageInfo.hasNextPage) break
		after = data.search.pageInfo.endCursor
	}
	await loadFailedRuns(out)
	return out
}

type ContextNode = {name?: string; context?: string; conclusion?: string; detailsUrl?: string; state?: string; targetUrl?: string}
type FailedRunsData = {repository: Record<string, {commits: {nodes: {commit: {statusCheckRollup: {contexts: {nodes: ContextNode[]}} | null}}[]}} | null>}

async function loadFailedRuns(prs: PR[]): Promise<void> {
	const red = prs.filter(p => p.ci === 'FAILURE' || p.ci === 'ERROR')
	const byRepo = Map.groupBy(red, p => p.repo)
	await Promise.all([...byRepo].map(async ([repo, list]) => {
		const [owner, name] = repo.split('/')
		const fields = list.map(p => `p${p.number}:pullRequest(number:${p.number}){commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}}`).join(' ')
		const data = await graphql<FailedRunsData>(`query{repository(owner:"${owner}",name:"${name}"){${fields}}}`, {}).catch(() => null)
		for (const pr of list) {
			const contexts = data?.repository[`p${pr.number}`]?.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
			const runs = new Set<string>()
			const checks: {name: string; url: string}[] = []
			for (const c of contexts) {
				const failed = c.conclusion === 'FAILURE' || c.state === 'FAILURE' || c.state === 'ERROR'
				if (!failed) continue
				const url = c.detailsUrl ?? c.targetUrl ?? ''
				checks.push({name: c.name ?? c.context ?? 'check', url})
				const m = url.match(/\/runs\/(\d+)\//)
				if (m) runs.add(m[1])
			}
			pr.failedRuns = [...runs]
			pr.failedChecks = checks
		}
	}))
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

export async function merge(pr: PR): Promise<string> {
	let r = await $`gh pr merge ${pr.number} --repo ${pr.repo} --auto`.quiet().nothrow()
	if (r.exitCode !== 0 && /merge method|strategy|--squash/i.test(r.stderr.toString())) {
		r = await $`gh pr merge ${pr.number} --repo ${pr.repo} --auto --squash`.quiet().nothrow()
	}
	if (r.exitCode !== 0) return `Merge failed: ${r.stderr.toString().trim().split('\n').pop()}`
	const out = r.stdout.toString() + r.stderr.toString()
	return /queue/i.test(out) ? `#${pr.number} added to the merge queue` : /auto-merge|automatically/i.test(out) ? `Auto-merge enabled for #${pr.number}` : `#${pr.number}: ${out.trim().split('\n').pop() || 'merge requested'}`
}

export function failureReport(pr: PR): string {
	const lines = [`${pr.repo}#${pr.number} ${pr.title}`, pr.url, '']
	if (pr.failedChecks.length) {
		lines.push('Failed checks:')
		for (const c of pr.failedChecks) lines.push(`- ${c.name} ${c.url}`)
	}
	if (pr.unresolved.length) {
		if (lines.length > 3) lines.push('')
		lines.push('Unresolved threads:')
		for (const t of pr.unresolved) lines.push(`- ${t.path} (${t.by}): ${t.body.replace(/\s+/g, ' ').slice(0, 300)}`)
	}
	if (pr.mergeable === 'CONFLICTING') lines.push('', 'Merge conflicts with base branch')
	return lines.join('\n')
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
