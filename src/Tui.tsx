/** @jsxImportSource @opentui/react */
import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {TextAttributes} from '@opentui/core'
import {useAnimationTick, useKeyboard, useRenderer, useTerminalDimensions} from '@opentui/react'
import {approve, failureReport, fetchForReview, fetchPRs, merge, openInBrowser, RateLimitError, rerunFailed, type PR} from './github'
import {batchNudgeMessages, copy, nudgeMessage} from './nudge'
import {runClaudeReview, type ReviewRun} from './review'

const GAP = 1
const MIN_CARD = 64
const MAX_CARD = 110
const CARD_H = 7
const COMPACT_W = 12
const COMPACT_H = 6
const CHROME_H = 1 + 3 + 3

type Tab = 'mine' | 'review'
type Action = 'nudge' | 'rerun' | 'approve' | 'open' | 'merge' | 'copyfail' | 'review'
interface Button { label: string; action: Action; fg: string }

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const GRAY = '#8a8a8a'
const SUCCESS = '#3a9d5d'
const DANGER = '#d9534f'
const AMBER = '#d08c2a'
const QUEUE = '#b8860b'
const ACCENT = '#5b7fd6'
const PURPLE = '#9a6fc9'
const TOAST_BG = '#262a33'
const BUTTON_BG: Record<string, string> = {cyan: '#79c7e3', green: '#8fd3a4', red: '#f3a09c', purple: '#c9b3e6'}
const LINE = {truncate: true, wrapMode: 'none'} as const

function ago(iso: string): string {
	const diff = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
	return `${Math.floor(diff / 86400)}d ago`
}

function cardColor(pr: PR): string {
	if (pr.queue?.state === 'UNMERGEABLE') return DANGER
	if (pr.inMergeQueue) return QUEUE
	if (pr.unresolved.length > 0 || pr.mergeable === 'CONFLICTING' || pr.ci === 'FAILURE' || pr.ci === 'ERROR') return DANGER
	if (pr.ci === 'PENDING' || pr.ci === 'EXPECTED') return AMBER
	if (pr.ci === 'SUCCESS') return SUCCESS
	return GRAY
}

function queueLabel(pr: PR): string | null {
	if (!pr.queue) return pr.inMergeQueue ? 'in merge queue' : null
	const state = {AWAITING_CHECKS: 'checks running', QUEUED: 'queued', LOCKED: 'merging', MERGEABLE: 'ready', UNMERGEABLE: 'unmergeable'}[pr.queue.state] ?? pr.queue.state.toLowerCase()
	const eta = pr.queue.eta ? ` ~${Math.max(1, Math.round(pr.queue.eta / 60))}m` : ''
	return `queue #${pr.queue.position} ${state}${eta}`
}

function ciLabel(pr: PR): {glyph: string; text: string} {
	switch (pr.ci) {
		case 'SUCCESS': return {glyph: '✓', text: 'CI green'}
		case 'FAILURE': case 'ERROR': return {glyph: '✗', text: 'CI red'}
		case 'PENDING': case 'EXPECTED': return {glyph: '●', text: 'CI running'}
		default: return {glyph: '○', text: 'no CI'}
	}
}

function buttonsFor(pr: PR, tab: Tab): Button[] {
	if (tab === 'mine') {
		const b: Button[] = [{label: ' nudge ', action: 'nudge', fg: 'cyan'}]
		if (pr.failedRuns.length > 0) b.push({label: ' rerun CI ', action: 'rerun', fg: 'red'})
		if (pr.ci === 'FAILURE' || pr.ci === 'ERROR' || pr.unresolved.length > 0 || pr.mergeable === 'CONFLICTING') b.push({label: ' copy fail ', action: 'copyfail', fg: 'red'})
		if (!pr.isDraft && !pr.inMergeQueue && !pr.autoMerge && pr.mergeable !== 'CONFLICTING') b.push({label: ' merge ', action: 'merge', fg: 'green'})
		b.push({label: ' open ', action: 'open', fg: 'cyan'})
		b.push({label: ' claude ', action: 'review', fg: 'purple'})
		return b
	}
	return [{label: ' approve ', action: 'approve', fg: 'green'}, {label: ' open ', action: 'open', fg: 'cyan'}, {label: ' claude ', action: 'review', fg: 'purple'}]
}

function Button({label, color, pressed, onPress}: {label: string; color: string; pressed: boolean; onPress: () => void}) {
	const [down, setDown] = useState(false)
	const active = pressed || down
	return (
		<box onMouseDown={() => setDown(true)} onMouseUp={() => { if (down) onPress(); setDown(false) }} onMouseOut={() => setDown(false)}>
			<text fg={active ? color : '#000000'} bg={active ? '#000000' : color} attributes={TextAttributes.BOLD}>{active ? `▸${label.trim()}◂` : label}</text>
		</box>
	)
}

function TabButton({label, color, active, flash, onPress}: {label: string; color: string; active: boolean; flash: boolean; onPress: () => void}) {
	const [down, setDown] = useState(false)
	const pressed = down || flash
	const fg = pressed ? (active ? color : '#ffffff') : active ? '#ffffff' : color
	const bg = pressed ? (active ? '#ffffff' : color) : active ? color : undefined
	return (
		<box onMouseDown={() => setDown(true)} onMouseUp={() => { if (down) onPress(); setDown(false) }} onMouseOut={() => setDown(false)}>
			<text fg={fg} bg={bg} attributes={TextAttributes.BOLD}>{label}</text>
		</box>
	)
}

function Spinner() {
	const [i, setI] = useState(0)
	useAnimationTick(12, () => setI(n => (n + 1) % SPINNER.length))
	return <span fg={AMBER}>{SPINNER[i]}</span>
}

const Card = memo(function Card({pr, width, tab, busy, selected, pressed, onAction, onSelect}: {pr: PR; width: number; tab: Tab; busy?: string; selected: boolean; pressed?: Action; onAction: (pr: PR, a: Action) => void; onSelect: (pr: PR) => void}) {
	const color = cardColor(pr)
	const {glyph, text} = ciLabel(pr)
	const buttons = buttonsFor(pr, tab)
	return (
		<box flexDirection="column" border borderStyle={selected ? "double" : "rounded"} borderColor={color} width={width} height={CARD_H} paddingLeft={1} paddingRight={1} onMouseDown={() => onSelect(pr)}>
			<text {...LINE}>
				<span fg={color}>{glyph} </span>
				<span attributes={TextAttributes.BOLD}><a href={pr.url}>{pr.title}</a></span>
				<span fg={GRAY}>  #{pr.number}</span>
				{pr.isDraft ? <span fg={GRAY}> draft</span> : null}
				{tab === 'review' ? <span fg={PURPLE}>  {pr.author}</span> : null}
			</text>
			<text {...LINE}>
				<span fg={color}>{queueLabel(pr) ?? text}</span>
				{pr.mergeable === 'CONFLICTING' ? <span fg={DANGER}> · conflicts</span> : null}
				{!queueLabel(pr) && pr.autoMerge ? <span fg={SUCCESS}> · auto-merge</span> : null}
				{pr.unresolved.length > 0 ? <span fg={DANGER}> · ✎ {pr.unresolved.length} unresolved</span> : null}
				{pr.changesRequested.length > 0 ? <span fg={DANGER}> · changes requested</span> : null}
				<span fg={GRAY}> · {ago(pr.updatedAt)}</span>
				{pr.approvals.length > 0 ? <span fg={SUCCESS}> · ✓ {pr.approvals.join(', ')}</span> : <span fg={GRAY}> · no approvals</span>}
			</text>
			<text {...LINE}><span fg={AMBER}>teams </span>{pr.pendingTeams.length ? pr.pendingTeams.map(t => t.replace(/^.*\//, '')).join('  ') : <span fg={GRAY}>none</span>}</text>
			<text {...LINE}><span fg={AMBER}>users </span>{pr.pendingUsers.length ? pr.pendingUsers.join('  ') : <span fg={GRAY}>none</span>}</text>
			<box flexDirection="row">
				{buttons.map((b, i) => (
					<box key={b.action} marginLeft={i > 0 ? 1 : 0}>
						<Button label={b.label} color={BUTTON_BG[b.fg]} pressed={pressed === b.action} onPress={() => onAction(pr, b.action)} />
					</box>
				))}
				{busy ? <text fg={busy.startsWith('✓') ? SUCCESS : busy.startsWith('✗') ? DANGER : AMBER}>  {busy}</text> : null}
			</box>
		</box>
	)
})

const CompactCard = memo(function CompactCard({pr, tab, selected, onSelect}: {pr: PR; tab: Tab; selected: boolean; onSelect: (pr: PR) => void}) {
	const color = cardColor(pr)
	const marks = [
		pr.unresolved.length > 0 ? `✎${pr.unresolved.length}` : '',
		pr.mergeable === 'CONFLICTING' ? '⚡' : '',
		pr.inMergeQueue ? 'Q' : pr.autoMerge ? 'A' : '',
		pr.isDraft ? 'D' : '',
	].filter(Boolean).join(' ')
	const pending = pr.pendingTeams.length + pr.pendingUsers.length
	return (
		<box flexDirection="column" border borderStyle={selected ? 'double' : 'rounded'} borderColor={color} width={COMPACT_W} height={COMPACT_H} paddingLeft={1} onMouseDown={() => onSelect(pr)}>
			<text {...LINE}><span fg={color}>{ciLabel(pr).glyph} </span><span attributes={TextAttributes.BOLD}><a href={pr.url}>#{pr.number}</a></span></text>
			<text {...LINE}>{marks ? <span fg={color}>{marks}</span> : <span fg={GRAY}>·</span>}</text>
			<text {...LINE}>{tab === 'mine' && pr.approvals.length > 0 ? <span fg={SUCCESS}>✓ {pr.approvals.length} </span> : null}{pending > 0 ? <span fg={AMBER}>◌ {pending}</span> : null}</text>
			<text {...LINE}><span fg={GRAY}>{ago(pr.updatedAt)}</span></text>
		</box>
	)
})

interface Review { pr: PR; status: 'running' | 'done' | 'error'; text: string; error: string; scroll: number; run?: ReviewRun }

function wrapLines(text: string, width: number): string[] {
	const out: string[] = []
	for (const raw of text.split('\n')) {
		let line = raw.replace(/\t/g, '    ')
		if (line.length === 0) { out.push(''); continue }
		while (line.length > width) {
			let cut = line.lastIndexOf(' ', width)
			if (cut < width * 0.6) cut = width
			out.push(line.slice(0, cut))
			line = line.slice(cut).trimStart()
		}
		out.push(line)
	}
	return out
}

function ReviewPane({review, width, height}: {review: Review; width: number; height: number}) {
	const lines = useMemo(() => wrapLines(review.text, Math.max(20, width - 4)), [review.text, width])
	const maxScroll = Math.max(0, lines.length - height)
	const start = review.status === 'running' && review.scroll === 0 ? maxScroll : Math.min(review.scroll, maxScroll)
	const visible = lines.slice(start, start + height)
	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
			<text {...LINE}>
				<span attributes={TextAttributes.BOLD}>Claude review · </span>
				<span attributes={TextAttributes.BOLD}><a href={review.pr.url}>{review.pr.title}</a></span>
				<span fg={GRAY}>  #{review.pr.number}</span>
				{review.status === 'running' ? <span fg={AMBER}>  <Spinner /> reviewing…</span> : review.status === 'error' ? <span fg={DANGER}>  ✗ {review.error}</span> : <span fg={SUCCESS}>  ✓ done</span>}
				{lines.length > height ? <span fg={GRAY}>  · lines {start + 1}–{Math.min(lines.length, start + height)} of {lines.length}</span> : null}
			</text>
			<text fg={GRAY} {...LINE}>{'─'.repeat(Math.max(0, width - 4))}</text>
			{visible.map((l, i) => <text key={start + i} {...LINE}>{l || ' '}</text>)}
		</box>
	)
}

export function Tui({repos, interval, repoDirs}: {repos: string[]; interval: number; repoDirs: Record<string, string>}) {
	const renderer = useRenderer()
	const {width: cols, height: rows} = useTerminalDimensions()
	const [tab, setTab] = useState<Tab>('mine')
	const [reviews, setReviews] = useState<Record<string, Review>>({})
	const [view, setView] = useState<string>('mine')
	const [data, setData] = useState<Record<Tab, PR[] | null>>({mine: null, review: null})
	const loadedAt = useRef<Record<Tab, number>>({mine: 0, review: 0})
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [toast, setToast] = useState<string | null>(null)
	useEffect(() => {
		if (toast === null) return
		const t = setTimeout(() => setToast(null), 6000)
		return () => clearTimeout(t)
	}, [toast])
	const [selected, setSelected] = useState<Record<Tab, number | null>>({mine: null, review: null})
	const [busy, setBusy] = useState<Record<string, string>>({})
	const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
	const [page, setPage] = useState<Record<Tab, number>>({mine: 0, review: 0})
	const [compact, setCompact] = useState(false)
	const [pressed, setPressed] = useState<string | null>(null)
	const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const press = useCallback((key: string) => {
		setPressed(key)
		if (pressTimer.current) clearTimeout(pressTimer.current)
		pressTimer.current = setTimeout(() => setPressed(null), 250)
	}, [])

	const [retryAt, setRetryAt] = useState<number | null>(null)
	const inFlight = useRef<Set<Tab>>(new Set())
	const refresh = useCallback(async (which: Tab) => {
		if (inFlight.current.has(which)) return
		inFlight.current.add(which)
		setLoading(true)
		setRetryAt(null)
		let delay = 30_000
		try {
			for (;;) {
				try {
					const list = which === 'mine' ? await fetchPRs(repos) : await fetchForReview(repos)
					setData(d => ({...d, [which]: list}))
					loadedAt.current[which] = Date.now()
					setError(null)
					setUpdatedAt(new Date())
					return
				} catch (e) {
					if (!(e instanceof RateLimitError)) { setError((e as Error).message); return }
					const until = Math.max(e.resetAt, Date.now() + delay)
					delay = Math.min(delay * 2, 10 * 60_000)
					setRetryAt(until)
					await new Promise(r => setTimeout(r, until - Date.now()))
				}
			}
		} finally {
			inFlight.current.delete(which)
			setLoading(false)
			setRetryAt(null)
		}
	}, [repos])

	useEffect(() => {
		let cancelled = false
		let t: ReturnType<typeof setTimeout> | undefined
		const tick = async () => {
			if (Date.now() - loadedAt.current[tab] >= interval * 1000) await refresh(tab)
			if (!cancelled) t = setTimeout(tick, 1000)
		}
		tick()
		return () => { cancelled = true; if (t) clearTimeout(t) }
	}, [refresh, interval, tab])

	const act = useCallback(async (pr: PR, action: Action) => {
		const key = pr.url
		press(`${pr.url}:${action}`)
		if (action === 'nudge') {
			const ok = await copy(nudgeMessage(pr))
			setBusy(b => ({...b, [key]: ok ? '✓ Copied to clipboard' : '✗ pbcopy failed'}))
			setTimeout(() => setBusy(b => { const {[key]: _, ...rest} = b; return rest }), 3000)
			return
		}
		if (action === 'open') { await openInBrowser(pr); return }
		if (action === 'review') {
			const id = `claude:${pr.number}`
			setReviews(r => { r[id]?.run?.abort(); return {...r, [id]: {pr, status: 'running', text: '', error: '', scroll: 0}} })
			setView(id)
			const run = runClaudeReview(pr, repoDirs, text => setReviews(r => r[id] ? {...r, [id]: {...r[id], text}} : r))
			setReviews(r => r[id] ? {...r, [id]: {...r[id], run}} : r)
			run.done.then(({exitCode, error}) => setReviews(r => r[id] ? {...r, [id]: {...r[id], status: exitCode === 0 ? 'done' : 'error', error, scroll: 0}} : r))
			return
		}
		if (action === 'copyfail') {
			const ok = await copy(failureReport(pr))
			setBusy(b => ({...b, [key]: ok ? '✓ Copied failure report' : '✗ pbcopy failed'}))
			setTimeout(() => setBusy(b => { const {[key]: _, ...rest} = b; return rest }), 3000)
			return
		}
		if (action === 'merge') {
			setBusy(b => ({...b, [key]: 'merging…'}))
			const msg = await merge(pr)
			setToast(msg)
			setBusy(b => { const {[key]: _, ...rest} = b; return rest })
			if (!msg.startsWith('Merge failed')) await refresh('mine')
			return
		}
		if (action === 'approve') {
			setBusy(b => ({...b, [key]: 'approving…'}))
			const msg = await approve(pr)
			setToast(msg)
			setBusy(b => { const {[key]: _, ...rest} = b; return rest })
			if (msg.startsWith('Approved')) setData(d => ({...d, review: (d.review ?? []).filter(p => p.url !== pr.url)}))
			return
		}
		setBusy(b => ({...b, [key]: 'requesting rerun…'}))
		const rerun = await rerunFailed(pr)
		setToast(rerun.message)
		if (rerun.accepted === 0) {
			setBusy(b => ({...b, [key]: '✗ rerun refused (run still in progress?)'}))
			setTimeout(() => setBusy(b => { const {[key]: _, ...rest} = b; return rest }), 5000)
			return
		}
		setBusy(b => ({...b, [key]: '✓ rerun requested, waiting for CI…'}))
		for (let i = 0; i < 10; i++) {
			await new Promise(r => setTimeout(r, 3000))
			const fresh = await fetchPRs(repos).catch(() => null)
			if (!fresh) continue
			setData(d => ({...d, mine: fresh})); loadedAt.current.mine = Date.now()
			const me = fresh.find(p => p.url === pr.url)
			if (!me || me.ci !== 'FAILURE') break
		}
		setBusy(b => { const {[key]: _, ...rest} = b; return rest })
	}, [repos, refresh, press, repoDirs])

	const list = data[tab] ?? []
	const layout = useMemo(() => {
		if (compact) {
			const n = Math.max(1, Math.floor((cols + GAP) / (COMPACT_W + GAP)))
			const rowsFit = Math.max(1, Math.floor((rows - CHROME_H) / COMPACT_H))
			return {n, w: COMPACT_W, perPage: n * rowsFit}
		}
		let n = Math.floor((cols + GAP) / (MIN_CARD + GAP))
		n = Math.max(1, Math.min(3, n))
		const w = Math.min(MAX_CARD, Math.max(50, Math.floor((cols - GAP * (n - 1)) / n)))
		const rowsFit = Math.max(1, Math.floor((rows - CHROME_H) / CARD_H))
		return {n, w, perPage: n * rowsFit}
	}, [cols, rows, compact])
	const pageCount = Math.max(1, Math.ceil(list.length / layout.perPage))
	const current = Math.min(page[tab], pageCount - 1)
	const visible = list.slice(current * layout.perPage, (current + 1) * layout.perPage)
	const cardRows: PR[][] = []
	for (let i = 0; i < visible.length; i += layout.n) cardRows.push(visible.slice(i, i + layout.n))

	const sel = selected[tab] === null ? null : Math.min(selected[tab]!, Math.max(0, list.length - 1))
	const selPr: PR | undefined = sel === null ? undefined : list[sel]
	const switchTab = (t: Tab) => { press(`tab:${t}`); setTab(t); setView(t) }
	const select = useCallback((i: number | null) => {
		setSelected(s => ({...s, [tab]: i}))
		if (i !== null) setPage(p => ({...p, [tab]: Math.floor(i / layout.perPage)}))
	}, [tab, layout.perPage])
	const selectPr = useCallback((pr: PR) => { const i = list.indexOf(pr); if (i >= 0) select(i) }, [list, select])

	const nudgePart = useRef(0)
	const nudgeAll = useCallback(async () => {
		const parts = batchNudgeMessages(list)
		if (!parts.length) { setToast('nothing to nudge'); return }
		const i = nudgePart.current % parts.length
		nudgePart.current = i + 1
		const teams = (parts[i].match(/^:busts_in_silhouette:/gm) ?? []).length
		const which = parts.length > 1 ? `part ${i + 1}/${parts.length} (${teams} teams, ${parts[i].length} chars)` : `${teams} teams, ${parts[i].length} chars`
		const next = parts.length > 1 ? (i + 1 < parts.length ? ' · press N again for the next part' : ' · that was the last part') : ''
		setToast((await copy(parts[i])) ? `✓ Copied batch nudge ${which}${next}` : '✗ pbcopy failed')
	}, [list])

	const copyFailAll = useCallback(async () => {
		const failing = list.filter(pr => pr.ci === 'FAILURE' || pr.ci === 'ERROR' || pr.unresolved.length > 0 || pr.mergeable === 'CONFLICTING')
		if (!failing.length) { setToast('nothing is failing'); return }
		const text = failing.map(failureReport).join('\n\n' + '='.repeat(60) + '\n\n')
		setToast((await copy(text)) ? `✓ Copied failure report for ${failing.length} PR${failing.length === 1 ? '' : 's'}` : '✗ pbcopy failed')
	}, [list])

	useKeyboard(key => {
		if (key.name === 'F' || (key.shift && key.name === 'f')) { press('copyFailAll'); copyFailAll(); return }
		if (key.name === 'N' || (key.shift && key.name === 'n')) { if (tab === 'mine') { press('nudgeAll'); nudgeAll() } return }
		if (key.name === 'q' || (key.ctrl && key.name === 'c')) { renderer.destroy(); process.exit(0) }
		if (key.name === 'r') { refresh(tab); return }
		if (key.name === 'v') { press('compact'); setCompact(c => !c); return }
		const views = ['mine', 'review', ...Object.keys(reviews)]
		if (key.name === 'tab' || key.name === 't') {
			const next = views[(views.indexOf(view) + (key.shift ? views.length - 1 : 1)) % views.length]
			if (next === 'mine' || next === 'review') switchTab(next as Tab)
			setView(next)
			return
		}
		if (view.startsWith('claude:')) {
			const rv = reviews[view]
			if (key.name === 'x') {
				rv?.run?.abort()
				const idx = views.indexOf(view)
				setReviews(r => { const {[view]: _, ...rest} = r; return rest })
				const remaining = views.filter(v => v !== view)
				setView(remaining[Math.min(idx, remaining.length - 1)] ?? 'mine')
				return
			}
			if (key.name === 'escape') { setView(tab); return }
			const scrollBy = (n: number) => setReviews(r => r[view] ? {...r, [view]: {...r[view], scroll: Math.max(0, r[view].scroll + n)}} : r)
			if (key.name === 'down' || key.name === 'j') { scrollBy(1); return }
			if (key.name === 'up' || key.name === 'k') { scrollBy(-1); return }
			if (key.name === 'pagedown' || key.name === ']') { scrollBy(rows - CHROME_H - 2); return }
			if (key.name === 'pageup' || key.name === '[') { scrollBy(-(rows - CHROME_H - 2)); return }
			if (key.name === 'home') { setReviews(r => r[view] ? {...r, [view]: {...r[view], scroll: 0}} : r); return }
			if (key.name === 'end') { setReviews(r => r[view] ? {...r, [view]: {...r[view], scroll: 1e9}} : r); return }
			if (key.name === 'o' || key.name === 'return') { if (rv) openInBrowser(rv.pr); return }
			return
		}
		if (key.name === 'escape') { select(null); return }
		if (!list.length) return
		const last = list.length - 1
		if (key.name === 'pagedown' || key.name === ']') { setPage(p => ({...p, [tab]: Math.min(pageCount - 1, p[tab] + 1)})); if (sel !== null) select(Math.min(last, sel + layout.perPage)); return }
		if (key.name === 'pageup' || key.name === '[') { setPage(p => ({...p, [tab]: Math.max(0, p[tab] - 1)})); if (sel !== null) select(Math.max(0, sel - layout.perPage)); return }
		const nav: Record<string, number> = {right: 1, l: 1, left: -1, h: -1, down: layout.n, j: layout.n, up: -layout.n, k: -layout.n}
		if (key.name in nav) { select(sel === null ? current * layout.perPage : Math.max(0, Math.min(last, sel + nav[key.name]))); return }
		if (key.name === 'home') { select(0); return }
		if (key.name === 'end') { select(last); return }
		const map: Record<string, Action | undefined> = {n: 'nudge', c: 'rerun', a: 'approve', o: 'open', return: 'open', m: 'merge', f: 'copyfail', i: 'review'}
		const action = map[key.name]
		if (selPr && action && buttonsFor(selPr, tab).some(b => b.action === action)) act(selPr, action)
	})

	const red = list.filter(p => p.ci === 'FAILURE' || p.ci === 'ERROR').length
	const unresolved = list.filter(p => p.unresolved.length > 0).length
	const waiting = list.filter(p => p.pendingTeams.length + p.pendingUsers.length > 0).length
	const hint = view.startsWith('claude:') ? '↑↓ PgUp/PgDn scroll · o open PR · x close tab · Esc back' : tab === 'mine' ? 'n nudge · c rerun CI · f copy fail · m merge · o open · i claude review' : 'a approve · o open · i claude review'
	const tabLabel = (t: Tab) => {
		const name = t === 'mine' ? 'Mine' : 'To review'
		return t === tab && data[t] ? ` ${name} ${data[t]!.length} ` : ` ${name} `
	}

	return (
		<box flexDirection="column" width={cols} height={rows}>
			<box flexDirection="row">
				<TabButton label={tabLabel('mine')} color={ACCENT} active={view === 'mine'} flash={pressed === 'tab:mine'} onPress={() => switchTab('mine')} />
				<box marginLeft={2}><TabButton label={tabLabel('review')} color={PURPLE} active={view === 'review'} flash={pressed === 'tab:review'} onPress={() => switchTab('review')} /></box>
				{Object.entries(reviews).map(([id, rv]) => (
					<box key={id} marginLeft={2}><TabButton label={` ${rv.status === 'running' ? '◌' : rv.status === 'error' ? '✗' : '✓'} #${rv.pr.number} `} color={PURPLE} active={view === id} flash={pressed === `tab:${id}`} onPress={() => { press(`tab:${id}`); setView(id) }} /></box>
				))}
				{tab === 'mine' ? <box marginLeft={4}><Button label=" nudge all " color={BUTTON_BG.cyan} pressed={pressed === 'nudgeAll'} onPress={() => { press('nudgeAll'); nudgeAll() }} /></box> : null}
				{list.some(pr => pr.ci === 'FAILURE' || pr.ci === 'ERROR' || pr.unresolved.length > 0 || pr.mergeable === 'CONFLICTING') ? <box marginLeft={1}><Button label=" copy all fails " color={BUTTON_BG.red} pressed={pressed === 'copyFailAll'} onPress={() => { press('copyFailAll'); copyFailAll() }} /></box> : null}
				<box marginLeft={1}><Button label={compact ? ' full view ' : ' compact '} color={'#c9c9c9'} pressed={pressed === 'compact'} onPress={() => { press('compact'); setCompact(c => !c) }} /></box>
			</box>
			<box border borderStyle="rounded" borderColor={ACCENT} paddingLeft={1} paddingRight={1} height={3}>
				<text {...LINE}>
					<span attributes={TextAttributes.BOLD}>{tab === 'mine' ? 'My open pull requests' : 'Awaiting my review'}</span>
					<span>  </span>{loading || data[tab] === null ? <Spinner /> : <span> </span>}
					<span attributes={TextAttributes.BOLD}>  {list.length} open</span>
					<span fg={DANGER}>   ✗ {red} red CI</span>
					<span fg={DANGER}>   ✎ {unresolved} unresolved</span>
					<span fg={AMBER}>   ◌ {waiting} awaiting review</span>
					<span fg={GRAY}>   {repos.join(' ')}{updatedAt ? ` · ${updatedAt.toTimeString().slice(0, 5)}` : ''}</span>
					{pageCount > 1 ? <span fg={GRAY}>   page {current + 1}/{pageCount}</span> : null}
				</text>
			</box>
			{retryAt ? <text fg={AMBER} {...LINE}>GitHub rate limit hit · retrying at {new Date(retryAt).toTimeString().slice(0, 8)}</text> : error ? <text fg={DANGER} {...LINE}>{error}</text> : null}
			{view.startsWith('claude:') && reviews[view] ? <ReviewPane review={reviews[view]} width={cols} height={Math.max(1, rows - CHROME_H - 2)} /> : (
			<box flexDirection="column" flexGrow={1}>
				{cardRows.map((row, ri) => (
					<box key={ri} flexDirection="row">
						{row.map((pr, ci) => (
							<box key={pr.url} marginLeft={ci > 0 ? GAP : 0}>
								{compact
									? <CompactCard pr={pr} tab={tab} selected={pr === selPr} onSelect={selectPr} />
									: <Card pr={pr} width={layout.w} tab={tab} busy={busy[pr.url]} selected={pr === selPr} pressed={pressed?.startsWith(pr.url + ':') ? (pressed.slice(pr.url.length + 1) as Action) : undefined} onAction={act} onSelect={selectPr} />}
							</box>
						))}
					</box>
				))}
			</box>
			)}
			<box flexDirection="column" height={2}>
				<text fg={GRAY} {...LINE}>
					<span attributes={TextAttributes.BOLD}>↑↓←→</span> select · <span attributes={TextAttributes.BOLD}>Esc</span> clear · {hint}{tab === 'mine' ? <span> · <span attributes={TextAttributes.BOLD}>N</span> nudge all</span> : null} · <span attributes={TextAttributes.BOLD}>F</span> copy all fails · <span attributes={TextAttributes.BOLD}>PgUp/PgDn</span> page · <span attributes={TextAttributes.BOLD}>Tab</span> switch · <span attributes={TextAttributes.BOLD}>v</span> {compact ? 'full' : 'compact'} · <span attributes={TextAttributes.BOLD}>r</span> refresh · <span attributes={TextAttributes.BOLD}>q</span> quit · every {interval}s
				</text>
				<text {...LINE}>{compact && selPr ? <span fg={cardColor(selPr)}>#{selPr.number} {selPr.title}{busy[selPr.url] ? `  ${busy[selPr.url]}` : ''}</span> : ' '}</text>
			</box>
			{toast ? (() => {
				const bad = toast.startsWith('✗') || toast.startsWith('Merge failed')
				const w = Math.min(toast.length + 4, cols)
				return (
					<box position="absolute" top={1} left={Math.max(0, Math.floor((cols - w) / 2))} zIndex={10} border borderStyle="rounded" borderColor={bad ? DANGER : SUCCESS} backgroundColor={TOAST_BG} paddingLeft={1} paddingRight={1} width={w} height={3}>
						<text fg={bad ? BUTTON_BG.red : BUTTON_BG.green} bg={TOAST_BG} attributes={TextAttributes.BOLD} {...LINE}>{toast}</text>
					</box>
				)
			})() : null}
		</box>
	)
}
