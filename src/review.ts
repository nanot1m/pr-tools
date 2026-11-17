import type {PR} from './github'

export function reviewPrompt(pr: PR): string {
	return `Review pull request #${pr.number} in ${pr.repo} (${pr.url}). Use gh to read the PR description, the full diff and any existing review comments. Start with a short overview: what changes and why, in a few sentences. Then list review suggestions ordered by severity, each with a file reference and a one-line reason. Plain text, no markdown tables. Do not change any files.`
}

export function resolveRepoDir(pr: PR, repoDirs: Record<string, string>): string {
	return repoDirs[pr.repo] ?? repoDirs[pr.repo.split('/')[1]] ?? process.cwd()
}

const ALLOWED_TOOLS = ['Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(gh api:*)', 'Read', 'Grep', 'Glob']

export interface ReviewRun {
	abort: () => void
	done: Promise<{exitCode: number; error: string}>
}

export function runClaudeReview(pr: PR, repoDirs: Record<string, string>, onText: (text: string) => void): ReviewRun {
	const env = {...process.env}
	delete env.CLAUDECODE
	delete env.CLAUDE_CODE_ENTRYPOINT
	const proc = Bun.spawn(['claude', '-p', reviewPrompt(pr), '--output-format', 'text', '--allowedTools', ...ALLOWED_TOOLS], {
		cwd: resolveRepoDir(pr, repoDirs),
		env,
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore',
	})
	let text = ''
	const read = (async () => {
		const reader = proc.stdout.getReader()
		const dec = new TextDecoder()
		for (;;) {
			const {value, done} = await reader.read()
			if (done) break
			text += dec.decode(value, {stream: true})
			onText(text)
		}
	})()
	const done = (async () => {
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
		await read
		return {exitCode, error: exitCode === 0 ? '' : stderr.trim().split('\n').pop() ?? `claude exited with ${exitCode}`}
	})()
	return {abort: () => proc.kill(), done}
}
