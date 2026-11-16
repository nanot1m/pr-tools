import {$} from 'bun'
import type {PR} from './github'

export function slackHandle(slug: string): string {
	return `@${slug.replace(/^.*\//, '')}`
}

export function nudgeMessage(pr: PR): string {
	const tags = pr.pendingTeams.map(slackHandle).join(', ')
	return tags ? `Hi! ${tags}, could you please review ${pr.url}` : `Hi! Could you please review ${pr.url}`
}

function prLine(pr: PR): string {
	const marks = [pr.approvals.length ? `✅ ${pr.approvals.length}` : '', pr.autoMerge || pr.inMergeQueue ? '🚀 auto-merge' : ''].filter(Boolean)
	const title = pr.title.replace(/^[A-Z]+-\d+\s+/, '')
	return `• *#${pr.number}* ${title}${marks.length ? `  _${marks.join(' · ')}_` : ''}\n   ${pr.url}`
}

export function batchNudgeMessage(prs: PR[]): string {
	const byTeam = new Map<string, PR[]>()
	for (const pr of prs) {
		if (pr.isDraft || pr.ci === 'FAILURE' || pr.ci === 'ERROR') continue
		for (const team of pr.pendingTeams) {
			const list = byTeam.get(team) ?? []
			list.push(pr)
			byTeam.set(team, list)
		}
	}
	const groups = [...byTeam.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
	if (!groups.length) return ''
	const total = new Set(groups.flatMap(([, list]) => list.map(pr => pr.url))).size
	const ticket = prs.map(pr => pr.title.match(/^([A-Z]+-\d+)/)?.[1]).find(Boolean)
	const header = `:wave: *Review request${ticket ? ` · ${ticket}` : ''}* — ${total} PR${total === 1 ? '' : 's'}, CI green on all of them`
	const blocks = groups.map(([team, list]) => `:busts_in_silhouette: ${slackHandle(team)} · ${list.length}\n${list.map(prLine).join('\n')}`)
	return `${header}\n\n${blocks.join('\n\n')}\n\n:pray: Thank you!`
}

export async function copy(text: string): Promise<boolean> {
	const r = await $`pbcopy < ${new Response(text)}`.quiet().nothrow()
	return r.exitCode === 0
}
