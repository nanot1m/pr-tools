/** @jsxImportSource @opentui/react */
import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {TextAttributes} from '@opentui/core'
import {useAnimationTick, useKeyboard, useRenderer, useTerminalDimensions} from '@opentui/react'
import {approve, fetchForReview, fetchPRs, merge, openInBrowser, RateLimitError, rerunFailed, type PR} from './github'
import {copy, nudgeMessage} from './nudge'

const GAP = 2
const MIN_CARD = 64
const MAX_CARD = 110
const CARD_H = 12
const CHROME_H = 1 + 3 + 3

type Tab = 'mine' | 'review'
type Action = 'nudge' | 'rerun' | 'approve' | 'open' | 'merge'
interface Button { label: string; action: Action; fg: string }

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const GRAY = '#8a8a8a'
const LINE = {truncate: true, wrapMode: 'none'} as const

function ago(iso: string): string {
	const diff = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
	return `${Math.floor(diff / 86400)}d ago`
}

function cardColor(pr: PR): string {
	if (pr.unresolved.length > 0 || pr.mergeable === 'CONFLICTING' || pr.ci === 'FAILURE' || pr.ci === 'ERROR') return 'red'
	if (pr.ci === 'PENDING' || pr.ci === 'EXPECTED') return 'yellow'
	if (pr.ci === 'SUCCESS') return 'green'
	return GRAY
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
		if (!pr.isDraft && !pr.inMergeQueue && !pr.autoMerge && pr.mergeable !== 'CONFLICTING') b.push({label: ' merge ', action: 'merge', fg: 'green'})
		return b
	}
	return [{label: ' approve ', action: 'approve', fg: 'green'}, {label: ' open ', action: 'open', fg: 'cyan'}]
}

function Spinner() {
	const [i, setI] = useState(0)
	useAnimationTick(12, () => setI(n => (n + 1) % SPINNER.length))
	return <span fg="yellow">{SPINNER[i]}</span>
}

const Card = memo(function Card({pr, index, width, tab, busy, onAction}: {pr: PR; index: number; width: number; tab: Tab; busy?: string; onAction: (pr: PR, a: Action) => void}) {
	const color = cardColor(pr)
	const {glyph, text} = ciLabel(pr)
	const buttons = buttonsFor(pr, tab)
	return (
		<box flexDirection="column" border borderStyle="rounded" borderColor={color} width={width} height={CARD_H} paddingLeft={1} paddingRight={1}>
			<text {...LINE}>
				<span fg={color}>{glyph} </span>
				<span attributes={TextAttributes.BOLD}>{pr.repo.split('/')[1]}#{pr.number}</span>
				{pr.isDraft ? <span fg={GRAY}> draft</span> : null}
				{index <= 9 ? <span fg={GRAY}>  [{index}]</span> : null}
				{tab === 'review' ? <span fg="magenta">  {pr.author}</span> : null}
			</text>
			<text {...LINE} attributes={TextAttributes.BOLD}>{pr.title}</text>
			<text {...LINE} fg={GRAY}><a href={pr.url}>{pr.url}</a></text>
			<text fg={color}>{'─'.repeat(Math.max(0, width - 4))}</text>
			<text {...LINE}>
				<span fg={color}>{text}</span>
				{pr.mergeable === 'CONFLICTING' ? <span fg="red"> · conflicts</span> : null}
				{pr.inMergeQueue ? <span fg="green"> · in merge queue</span> : pr.autoMerge ? <span fg="green"> · auto-merge on</span> : null}
				<span fg={GRAY}> · {ago(pr.updatedAt)}</span>
				{pr.approvals.length > 0 ? <span fg="green"> · ✓ {pr.approvals.join(', ')}</span> : <span fg={GRAY}> · no approvals</span>}
			</text>
			<text {...LINE}><span fg="yellow">teams: </span>{pr.pendingTeams.length ? pr.pendingTeams.map(t => t.replace(/^.*\//, '')).join('  ') : <span fg={GRAY}>none</span>}</text>
			<text {...LINE}><span fg="yellow">users: </span>{pr.pendingUsers.length ? pr.pendingUsers.join('  ') : <span fg={GRAY}>none</span>}</text>
			{pr.unresolved.length > 0
				? <text {...LINE}><span fg="red">✎ {pr.unresolved.length} unresolved: </span>{pr.unresolved.map(t => `${t.path.split('/').pop()} (${t.by})`).join(', ')}</text>
				: pr.changesRequested.length > 0
					? <text {...LINE} fg="red">✎ changes requested by {pr.changesRequested.join(', ')}</text>
					: <text> </text>}
			<box flexDirection="row">
				{buttons.map((b, i) => (
					<box key={b.action} marginLeft={i > 0 ? 2 : 0} onMouseDown={() => onAction(pr, b.action)}>
						<text fg={b.fg} attributes={TextAttributes.INVERSE}>{b.label}</text>
					</box>
				))}
				{busy ? <text fg={busy.startsWith('✓') ? 'green' : busy.startsWith('✗') ? 'red' : 'yellow'}>  {busy}</text> : null}
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
	const [selected, setSelected] = useState<number | null>(null)
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
		const rowsFit = Math.max(1, Math.floor((rows - CHROME_H) / (CARD_H + 1)))
		return {n, w, perPage: n * rowsFit}
	}, [cols, rows])
	const pageCount = Math.max(1, Math.ceil(list.length / layout.perPage))
	const current = Math.min(page[tab], pageCount - 1)
	const visible = list.slice(current * layout.perPage, (current + 1) * layout.perPage)
	const cardRows: PR[][] = []
	for (let i = 0; i < visible.length; i += layout.n) cardRows.push(visible.slice(i, i + layout.n))

	const switchTab = (t: Tab) => { setTab(t); setSelected(null) }

	useKeyboard(key => {
		if (key.name === 'q' || (key.ctrl && key.name === 'c')) { renderer.destroy(); process.exit(0) }
		if (key.name === 'r') { refresh(tab); return }
		if (key.name === 'tab' || key.name === 't') { switchTab(tab === 'mine' ? 'review' : 'mine'); return }
		if (key.name === 'right' || key.name === 'pagedown') { setPage(p => ({...p, [tab]: Math.min(pageCount - 1, p[tab] + 1)})); return }
		if (key.name === 'left' || key.name === 'pageup') { setPage(p => ({...p, [tab]: Math.max(0, p[tab] - 1)})); return }
		if (selected !== null) {
			const pr = visible[selected - 1]
			setSelected(null)
			const map: Record<string, Action | undefined> = {n: 'nudge', c: 'rerun', a: 'approve', o: 'open', m: 'merge'}
			const action = map[key.name]
			if (pr && action && buttonsFor(pr, tab).some(b => b.action === action)) act(pr, action)
			return
		}
		if (/^[1-9]$/.test(key.name) && Number(key.name) <= visible.length) { setSelected(Number(key.name)); setToast(null) }
	})

	const red = list.filter(p => p.ci === 'FAILURE' || p.ci === 'ERROR').length
	const unresolved = list.filter(p => p.unresolved.length > 0).length
	const waiting = list.filter(p => p.pendingTeams.length + p.pendingUsers.length > 0).length
	const hint = tab === 'mine' ? 'n nudge · c rerun CI · m merge' : 'a approve · o open'
	const tabLabel = (t: Tab) => {
		const name = t === 'mine' ? 'Mine' : 'To review'
		return t === tab && data[t] ? ` ${name} ${data[t]!.length} ` : ` ${name} `
	}

	return (
		<box flexDirection="column" width={cols} height={rows}>
			<box flexDirection="row">
				<box onMouseDown={() => switchTab('mine')}><text fg="blue" attributes={tab === 'mine' ? TextAttributes.INVERSE : 0}>{tabLabel('mine')}</text></box>
				<box marginLeft={2} onMouseDown={() => switchTab('review')}><text fg="magenta" attributes={tab === 'review' ? TextAttributes.INVERSE : 0}>{tabLabel('review')}</text></box>
			</box>
			<box border borderStyle="rounded" borderColor="blue" paddingLeft={1} paddingRight={1} height={3}>
				<text {...LINE}>
					<span attributes={TextAttributes.BOLD}>{tab === 'mine' ? 'My open pull requests' : 'Awaiting my review'}</span>
					<span>  </span>{loading || data[tab] === null ? <Spinner /> : <span> </span>}
					<span attributes={TextAttributes.BOLD}>  {list.length} open</span>
					<span fg="red">   ✗ {red} red CI</span>
					<span fg="red">   ✎ {unresolved} unresolved</span>
					<span fg="yellow">   ◌ {waiting} awaiting review</span>
					<span fg={GRAY}>   {repos.join(' ')}{updatedAt ? ` · ${updatedAt.toTimeString().slice(0, 5)}` : ''}</span>
					{pageCount > 1 ? <span fg={GRAY}>   page {current + 1}/{pageCount} ←→</span> : null}
				</text>
			</box>
			{retryAt ? <text fg="yellow" {...LINE}>GitHub rate limit hit · retrying at {new Date(retryAt).toTimeString().slice(0, 8)}</text> : error ? <text fg="red" {...LINE}>{error}</text> : null}
			<box flexDirection="column" flexGrow={1}>
				{cardRows.map((row, ri) => (
					<box key={ri} flexDirection="row" marginTop={1}>
						{row.map((pr, ci) => (
							<box key={pr.url} marginLeft={ci > 0 ? GAP : 0}>
								<Card pr={pr} index={ri * layout.n + ci + 1} width={layout.w} tab={tab} busy={busy[pr.url]} onAction={act} />
							</box>
						))}
					</box>
				))}
			</box>
			<box flexDirection="column" height={2}>
				<text fg={GRAY} {...LINE}>
					click a button or tab · <span attributes={TextAttributes.BOLD}>[1-9]</span> then {hint} · <span attributes={TextAttributes.BOLD}>Tab</span> switch · <span attributes={TextAttributes.BOLD}>←→</span> page · <span attributes={TextAttributes.BOLD}>r</span> refresh · <span attributes={TextAttributes.BOLD}>q</span> quit · every {interval}s
					{selected !== null ? <span fg="yellow">   #{visible[selected - 1]?.number}: {hint}</span> : null}
				</text>
				<text fg="green" {...LINE}>{toast ?? ' '}</text>
			</box>
		</box>
	)
}
