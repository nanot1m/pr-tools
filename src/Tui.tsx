/** @jsxImportSource @opentui/react */
import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {TextAttributes} from '@opentui/core'
import {useAnimationTick, useKeyboard, useRenderer, useTerminalDimensions} from '@opentui/react'
import {approve, failureReport, fetchForReview, fetchPRs, merge, openInBrowser, RateLimitError, rerunFailed, type PR} from './github'
import {copy, nudgeMessage} from './nudge'

const GAP = 1
const MIN_CARD = 64
const MAX_CARD = 110
const CARD_H = 7
const CHROME_H = 1 + 3 + 3

type Tab = 'mine' | 'review'
type Action = 'nudge' | 'rerun' | 'approve' | 'open' | 'merge' | 'copyfail'
interface Button { label: string; action: Action; fg: string }

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const GRAY = '#8a8a8a'
const QUEUE = '#bf8700'
const AMBER = '#d78700'
const BUTTON_BG: Record<string, string> = {cyan: '#00d7d7', green: '#5fd75f', red: '#ff5f5f'}
const LINE = {truncate: true, wrapMode: 'none'} as const

function ago(iso: string): string {
	const diff = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
	return `${Math.floor(diff / 86400)}d ago`
}

function cardColor(pr: PR): string {
	if (pr.queue?.state === 'UNMERGEABLE') return 'red'
	if (pr.inMergeQueue) return QUEUE
	if (pr.unresolved.length > 0 || pr.mergeable === 'CONFLICTING' || pr.ci === 'FAILURE' || pr.ci === 'ERROR') return 'red'
	if (pr.ci === 'PENDING' || pr.ci === 'EXPECTED') return AMBER
	if (pr.ci === 'SUCCESS') return 'green'
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
		return b
	}
	return [{label: ' approve ', action: 'approve', fg: 'green'}, {label: ' open ', action: 'open', fg: 'cyan'}]
}

function Spinner() {
	const [i, setI] = useState(0)
	useAnimationTick(12, () => setI(n => (n + 1) % SPINNER.length))
	return <span fg={AMBER}>{SPINNER[i]}</span>
}

const Card = memo(function Card({pr, width, tab, busy, selected, onAction, onSelect}: {pr: PR; width: number; tab: Tab; busy?: string; selected: boolean; onAction: (pr: PR, a: Action) => void; onSelect: (pr: PR) => void}) {
	const color = cardColor(pr)
	const {glyph, text} = ciLabel(pr)
	const buttons = buttonsFor(pr, tab)
	return (
		<box flexDirection="column" border borderStyle={selected ? "double" : "rounded"} borderColor={selected ? "#ffffff" : color} width={width} height={CARD_H} paddingLeft={1} paddingRight={1} onMouseDown={() => onSelect(pr)}>
			<text {...LINE}>
				<span fg={color}>{glyph} </span>
				<span attributes={TextAttributes.BOLD}><a href={pr.url}>{pr.title}</a></span>
				<span fg={GRAY}>  #{pr.number}</span>
				{pr.isDraft ? <span fg={GRAY}> draft</span> : null}
				{tab === 'review' ? <span fg="magenta">  {pr.author}</span> : null}
			</text>
			<text {...LINE}>
				<span fg={color}>{queueLabel(pr) ?? text}</span>
				{pr.mergeable === 'CONFLICTING' ? <span fg="red"> · conflicts</span> : null}
				{!queueLabel(pr) && pr.autoMerge ? <span fg="green"> · auto-merge</span> : null}
				{pr.unresolved.length > 0 ? <span fg="red"> · ✎ {pr.unresolved.length} unresolved</span> : null}
				{pr.changesRequested.length > 0 ? <span fg="red"> · changes requested</span> : null}
				<span fg={GRAY}> · {ago(pr.updatedAt)}</span>
				{pr.approvals.length > 0 ? <span fg="green"> · ✓ {pr.approvals.join(', ')}</span> : <span fg={GRAY}> · no approvals</span>}
			</text>
			<text {...LINE}><span fg={AMBER}>teams </span>{pr.pendingTeams.length ? pr.pendingTeams.map(t => t.replace(/^.*\//, '')).join('  ') : <span fg={GRAY}>none</span>}</text>
			<text {...LINE}><span fg={AMBER}>users </span>{pr.pendingUsers.length ? pr.pendingUsers.join('  ') : <span fg={GRAY}>none</span>}</text>
			<box flexDirection="row">
				{buttons.map((b, i) => (
					<box key={b.action} marginLeft={i > 0 ? 1 : 0} onMouseDown={() => onAction(pr, b.action)}>
						<text fg="#000000" bg={BUTTON_BG[b.fg]} attributes={TextAttributes.BOLD}>{b.label}</text>
					</box>
				))}
				{busy ? <text fg={busy.startsWith('✓') ? 'green' : busy.startsWith('✗') ? 'red' : AMBER}>  {busy}</text> : null}
			</box>
		</box>
	)
})

export function Tui({repos, interval}: {repos: string[]; interval: number}) {
	const renderer = useRenderer()
	const {width: cols, height: rows} = useTerminalDimensions()
	const [tab, setTab] = useState<Tab>('mine')
	const [data, setData] = useState<Record<Tab, PR[] | null>>({mine: null, review: null})
	const loadedAt = useRef<Record<Tab, number>>({mine: 0, review: 0})
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [toast, setToast] = useState<string | null>(null)
	const [selected, setSelected] = useState<Record<Tab, number | null>>({mine: null, review: null})
	const [busy, setBusy] = useState<Record<string, string>>({})
	const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
	const [page, setPage] = useState<Record<Tab, number>>({mine: 0, review: 0})

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
		if (action === 'nudge') {
			const ok = await copy(nudgeMessage(pr))
			setBusy(b => ({...b, [key]: ok ? '✓ Copied to clipboard' : '✗ pbcopy failed'}))
			setTimeout(() => setBusy(b => { const {[key]: _, ...rest} = b; return rest }), 3000)
			return
		}
		if (action === 'open') { await openInBrowser(pr); return }
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
		setToast(await rerunFailed(pr))
		for (let i = 0; i < 10; i++) {
			await new Promise(r => setTimeout(r, 3000))
			const fresh = await fetchPRs(repos).catch(() => null)
			if (!fresh) continue
			setData(d => ({...d, mine: fresh})); loadedAt.current.mine = Date.now()
			const me = fresh.find(p => p.url === pr.url)
			if (!me || me.ci !== 'FAILURE') break
		}
		setBusy(b => { const {[key]: _, ...rest} = b; return rest })
	}, [repos, refresh])

	const list = data[tab] ?? []
	const layout = useMemo(() => {
		let n = Math.floor((cols + GAP) / (MIN_CARD + GAP))
		n = Math.max(1, Math.min(3, n))
		const w = Math.min(MAX_CARD, Math.max(50, Math.floor((cols - GAP * (n - 1)) / n)))
		const rowsFit = Math.max(1, Math.floor((rows - CHROME_H) / CARD_H))
		return {n, w, perPage: n * rowsFit}
	}, [cols, rows])
	const pageCount = Math.max(1, Math.ceil(list.length / layout.perPage))
	const current = Math.min(page[tab], pageCount - 1)
	const visible = list.slice(current * layout.perPage, (current + 1) * layout.perPage)
	const cardRows: PR[][] = []
	for (let i = 0; i < visible.length; i += layout.n) cardRows.push(visible.slice(i, i + layout.n))

	const sel = selected[tab] === null ? null : Math.min(selected[tab]!, Math.max(0, list.length - 1))
	const selPr: PR | undefined = sel === null ? undefined : list[sel]
	const switchTab = (t: Tab) => setTab(t)
	const select = useCallback((i: number | null) => {
		setSelected(s => ({...s, [tab]: i}))
		if (i !== null) setPage(p => ({...p, [tab]: Math.floor(i / layout.perPage)}))
	}, [tab, layout.perPage])
	const selectPr = useCallback((pr: PR) => { const i = list.indexOf(pr); if (i >= 0) select(i) }, [list, select])

	useKeyboard(key => {
		if (key.name === 'q' || (key.ctrl && key.name === 'c')) { renderer.destroy(); process.exit(0) }
		if (key.name === 'r') { refresh(tab); return }
		if (key.name === 'tab' || key.name === 't') { switchTab(tab === 'mine' ? 'review' : 'mine'); return }
		if (key.name === 'escape') { select(null); return }
		if (!list.length) return
		const last = list.length - 1
		if (key.name === 'pagedown' || key.name === ']') { setPage(p => ({...p, [tab]: Math.min(pageCount - 1, p[tab] + 1)})); if (sel !== null) select(Math.min(last, sel + layout.perPage)); return }
		if (key.name === 'pageup' || key.name === '[') { setPage(p => ({...p, [tab]: Math.max(0, p[tab] - 1)})); if (sel !== null) select(Math.max(0, sel - layout.perPage)); return }
		const nav: Record<string, number> = {right: 1, l: 1, left: -1, h: -1, down: layout.n, j: layout.n, up: -layout.n, k: -layout.n}
		if (key.name in nav) { select(sel === null ? current * layout.perPage : Math.max(0, Math.min(last, sel + nav[key.name]))); return }
		if (key.name === 'home') { select(0); return }
		if (key.name === 'end') { select(last); return }
		const map: Record<string, Action | undefined> = {n: 'nudge', c: 'rerun', a: 'approve', o: 'open', return: 'open', m: 'merge', f: 'copyfail'}
		const action = map[key.name]
		if (selPr && action && buttonsFor(selPr, tab).some(b => b.action === action)) act(selPr, action)
	})

	const red = list.filter(p => p.ci === 'FAILURE' || p.ci === 'ERROR').length
	const unresolved = list.filter(p => p.unresolved.length > 0).length
	const waiting = list.filter(p => p.pendingTeams.length + p.pendingUsers.length > 0).length
	const hint = tab === 'mine' ? 'n nudge · c rerun CI · f copy fail · m merge · o open' : 'a approve · o open'
	const tabLabel = (t: Tab) => {
		const name = t === 'mine' ? 'Mine' : 'To review'
		return t === tab && data[t] ? ` ${name} ${data[t]!.length} ` : ` ${name} `
	}

	return (
		<box flexDirection="column" width={cols} height={rows}>
			<box flexDirection="row">
				<box onMouseDown={() => switchTab('mine')}><text fg={tab === 'mine' ? '#ffffff' : '#5fafff'} bg={tab === 'mine' ? '#005fd7' : undefined} attributes={TextAttributes.BOLD}>{tabLabel('mine')}</text></box>
				<box marginLeft={2} onMouseDown={() => switchTab('review')}><text fg={tab === 'review' ? '#ffffff' : '#d75fd7'} bg={tab === 'review' ? '#8700af' : undefined} attributes={TextAttributes.BOLD}>{tabLabel('review')}</text></box>
			</box>
			<box border borderStyle="rounded" borderColor="blue" paddingLeft={1} paddingRight={1} height={3}>
				<text {...LINE}>
					<span attributes={TextAttributes.BOLD}>{tab === 'mine' ? 'My open pull requests' : 'Awaiting my review'}</span>
					<span>  </span>{loading || data[tab] === null ? <Spinner /> : <span> </span>}
					<span attributes={TextAttributes.BOLD}>  {list.length} open</span>
					<span fg="red">   ✗ {red} red CI</span>
					<span fg="red">   ✎ {unresolved} unresolved</span>
					<span fg={AMBER}>   ◌ {waiting} awaiting review</span>
					<span fg={GRAY}>   {repos.join(' ')}{updatedAt ? ` · ${updatedAt.toTimeString().slice(0, 5)}` : ''}</span>
					{pageCount > 1 ? <span fg={GRAY}>   page {current + 1}/{pageCount}</span> : null}
				</text>
			</box>
			{retryAt ? <text fg={AMBER} {...LINE}>GitHub rate limit hit · retrying at {new Date(retryAt).toTimeString().slice(0, 8)}</text> : error ? <text fg="red" {...LINE}>{error}</text> : null}
			<box flexDirection="column" flexGrow={1}>
				{cardRows.map((row, ri) => (
					<box key={ri} flexDirection="row">
						{row.map((pr, ci) => (
							<box key={pr.url} marginLeft={ci > 0 ? GAP : 0}>
								<Card pr={pr} width={layout.w} tab={tab} busy={busy[pr.url]} selected={pr === selPr} onAction={act} onSelect={selectPr} />
							</box>
						))}
					</box>
				))}
			</box>
			<box flexDirection="column" height={2}>
				<text fg={GRAY} {...LINE}>
					<span attributes={TextAttributes.BOLD}>↑↓←→</span> select · <span attributes={TextAttributes.BOLD}>Esc</span> clear · {hint} · <span attributes={TextAttributes.BOLD}>PgUp/PgDn</span> page · <span attributes={TextAttributes.BOLD}>Tab</span> switch · <span attributes={TextAttributes.BOLD}>r</span> refresh · <span attributes={TextAttributes.BOLD}>q</span> quit · every {interval}s
				</text>
				<text fg="green" {...LINE}>{toast ?? ' '}</text>
			</box>
		</box>
	)
}
