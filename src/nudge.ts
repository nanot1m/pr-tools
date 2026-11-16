import {$} from 'bun'
import {existsSync, readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import type {PR} from './github'

function teamHandles(): Record<string, string> {
	const p = `${homedir()}/.config/prs/teams.json`
	try {
		return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>) : {}
	} catch {
		return {}
	}
}

export function slackHandle(slug: string): string {
	const bare = slug.replace(/^.*\//, '')
	return teamHandles()[bare] ?? `@${bare}`
}

export function nudgeMessage(pr: PR): string {
	const tags = pr.pendingTeams.map(slackHandle).join(', ')
	return tags ? `Hi! ${tags}, could you please review ${pr.url}` : `Hi! Could you please review ${pr.url}`
}

export async function copy(text: string): Promise<boolean> {
	const r = await $`pbcopy < ${new Response(text)}`.quiet().nothrow()
	return r.exitCode === 0
}
