import {createCliRenderer} from '@opentui/core'
import {createRoot} from '@opentui/react'
import {Tui} from './Tui'
import {fetchPRs, rerunFailed} from './github'
import {copy, nudgeMessage} from './nudge'
import {CONFIG_PATH, loadConfig} from './config'

const config = loadConfig()

const args = process.argv.slice(2)
const repos: string[] = []
let json = false
let interval = config.interval
let cmd: 'tui' | 'nudge' | 'rerun' = 'tui'
let target: number | undefined

for (let i = 0; i < args.length; i++) {
	const a = args[i]
	if (a === '--json') json = true
	else if (a === '--watch' || a === '--interval') { if (/^\d+$/.test(args[i + 1] ?? '')) interval = Number(args[++i]) }
	else if (a === 'nudge' || a === 'rerun') { cmd = a; if (/^\d+$/.test(args[i + 1] ?? '')) target = Number(args[++i]) }
	else if (a === '-h' || a === '--help') {
		console.log(`prs [owner/repo ...] [--json] [--interval SECONDS]
prs nudge [PR]    copy a Slack review request to the clipboard
prs rerun <PR>    rerun the failed CI jobs of a PR
config: ${CONFIG_PATH}  {"repos": ["owner/repo"], "interval": 120}
keys in the UI: arrows select, Esc clear, n nudge, N nudge all, c rerun CI, f copy fail, m merge, o open, Tab switch, r refresh, q quit`)
		process.exit(0)
	} else if (/^[\w.-]+\/[\w.-]+$/.test(a)) repos.push(a)
}
if (repos.length === 0) repos.push(...config.repos)
if (repos.length === 0) {
	console.error(`No repositories given. Pass owner/repo or set "repos" in ${CONFIG_PATH}`)
	process.exit(1)
}

if (json) {
	console.log(JSON.stringify(await fetchPRs(repos), null, 2))
} else if (cmd === 'nudge' || cmd === 'rerun') {
	const prs = await fetchPRs(repos)
	let pr = target ? prs.find(p => p.number === target) : undefined
	if (!pr && cmd === 'nudge' && !target) {
		const waiting = prs.filter(p => p.pendingTeams.length + p.pendingUsers.length > 0)
		if (waiting.length === 0) { console.log('Nothing is waiting on a reviewer.'); process.exit(0) }
		for (const p of waiting) console.log(`  ${p.number}  ${p.title.slice(0, 70)}  (${[...p.pendingTeams, ...p.pendingUsers].join(', ')})`)
		process.stdout.write('Copy a Slack review request for which PR? ')
		const line = (await new Promise<string>(r => process.stdin.once('data', d => r(String(d))))).trim()
		pr = prs.find(p => p.number === Number(line))
	}
	if (!pr) { console.error(`PR ${target ?? ''} not found among your open PRs`); process.exit(1) }
	if (cmd === 'nudge') {
		const msg = nudgeMessage(pr)
		console.log((await copy(msg)) ? 'Copied to clipboard:' : 'pbcopy not available, message:')
		console.log(msg)
	} else {
		console.log(await rerunFailed(pr))
	}
	process.exit(0)
} else {
	const renderer = await createCliRenderer({useMouse: true, exitOnCtrlC: true, screenMode: 'alternate-screen', targetFps: 30})
	createRoot(renderer).render(<Tui repos={repos} interval={interval} />)
}
