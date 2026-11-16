import {$} from 'bun'
import {loadConfig} from './config'
import type {PR} from './github'

export function slackHandle(slug: string): string {
	const bare = slug.replace(/^.*\//, '')
	return loadConfig().teams[bare] ?? `@${bare}`
}

export function nudgeMessage(pr: PR): string {
	const tags = pr.pendingTeams.map(slackHandle).join(', ')
	return tags ? `Hi! ${tags}, could you please review ${pr.url}` : `Hi! Could you please review ${pr.url}`
}

export async function copy(text: string): Promise<boolean> {
	const r = await $`pbcopy < ${new Response(text)}`.quiet().nothrow()
	return r.exitCode === 0
}
