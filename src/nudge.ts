import {$} from 'bun'
import type {PR} from './github'

export function slackHandle(slug: string): string {
	return `@${slug.replace(/^.*\//, '')}`
}

export function nudgeMessage(pr: PR): string {
	const tags = pr.pendingTeams.map(slackHandle).join(', ')
	return tags ? `Hi! ${tags}, could you please review ${pr.url}` : `Hi! Could you please review ${pr.url}`
}

const SLACK_LIMIT = 3800

function commonPrefix(titles: string[]): string {
	if (titles.length < 2) return ''
	let prefix = titles[0]
	for (const t of titles) while (!t.startsWith(prefix)) prefix = prefix.slice(0, -1)
	return prefix.replace(/\S*$/, '')
}

function commonSuffix(titles: string[]): string {
	if (titles.length < 2) return ''
	let suffix = titles[0]
	for (const t of titles) while (!t.endsWith(suffix)) suffix = suffix.slice(1)
	return suffix.replace(/^\S*/, '')
}

function prLine(pr: PR, prefix: string, suffix: string): string {
	let title = pr.title.replace(/^[A-Z]+-\d+\s+/, '')
	if (prefix && title.startsWith(prefix)) title = title.slice(prefix.length)
	if (suffix && title.endsWith(suffix)) title = title.slice(0, -suffix.length)
	title = title.trim()
	return `• ${title} ${pr.url}`
}

export function batchNudgeMessages(prs: PR[]): string[] {
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
	if (!groups.length) return []
	const all = [...new Set(groups.flatMap(([, list]) => list))]
	const titles = all.map(pr => pr.title.replace(/^[A-Z]+-\d+\s+/, ''))
	const prefix = commonPrefix(titles)
	const suffix = commonSuffix(titles)
	const ticket = all.map(pr => pr.title.match(/^([A-Z]+-\d+)/)?.[1]).find(Boolean)
	const shape = prefix || suffix ? ` Each title reads "${prefix}…${suffix}".` : ''
	const header = `:wave: *Review request${ticket ? ` · ${ticket}` : ''}* — ${all.length} PR${all.length === 1 ? '' : 's'}, CI green on all.${shape}`
	const blocks: string[] = []
	for (const [team, list] of groups) {
		const lines = list.map(pr => prLine(pr, prefix, suffix))
		const perBlock = Math.max(1, Math.floor((SLACK_LIMIT - 200) / Math.max(...lines.map(l => l.length + 1))))
		for (let i = 0; i < lines.length; i += perBlock) {
			const chunk = lines.slice(i, i + perBlock)
			const label = lines.length > perBlock ? `${slackHandle(team)} · ${i + 1}–${i + chunk.length} of ${list.length}` : `${slackHandle(team)} · ${list.length}`
			blocks.push(`:busts_in_silhouette: ${label}\n${chunk.join('\n')}`)
		}
	}

	const parts: string[][] = [[]]
	let size = header.length
	for (const block of blocks) {
		if (size + block.length + 2 > SLACK_LIMIT && parts[parts.length - 1].length) { parts.push([]); size = 0 }
		parts[parts.length - 1].push(block)
		size += block.length + 2
	}
	return parts.map((blocksInPart, i) => {
		const head = i === 0 ? header : `:wave: *Review request${ticket ? ` · ${ticket}` : ''}* (${i + 1}/${parts.length})`
		const tail = i === parts.length - 1 ? '\n\n:pray: Thank you!' : parts.length > 1 ? `\n\n_(${i + 1}/${parts.length}, continued below)_` : ''
		return `${head}\n\n${blocksInPart.join('\n\n')}${tail}`
	})
}

export async function copy(text: string): Promise<boolean> {
	const r = await $`pbcopy < ${new Response(text)}`.quiet().nothrow()
	return r.exitCode === 0
}
