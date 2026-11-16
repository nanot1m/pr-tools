#!/usr/bin/env bash
# prs — my open PRs: CI, approvals, unresolved review threads, pending reviewers.
#
# Usage: prs [owner/repo ...] [--json] [--watch [SECONDS]] [--no-color|--color]
#        prs nudge [PR-number]      copy a Slack review request to the clipboard
#        prs rerun <PR-number>       rerun the failed CI jobs of a PR
#   default repo: miroapp-dev/client · --watch refreshes in place (default 120s)
#   team handles: ~/.config/prs/teams.json  {"github-slug": "@slack-handle"}
set -uo pipefail

REPOS=(); JSON=0; WATCH=0; COLOR=1; NUDGE=0; NUDGE_PR=""; RERUN_PR=""
while [ $# -gt 0 ]; do
	case "$1" in
		nudge) NUDGE=1; if [[ "${2:-}" =~ ^[0-9]+$ ]]; then NUDGE_PR=$2; shift; fi ;;
		rerun) RERUN_PR=${2:-}; shift ;;
		--json) JSON=1 ;;
		--no-color) COLOR=0 ;;
		--color) COLOR=2 ;;
		--watch) WATCH=120; if [[ "${2:-}" =~ ^[0-9]+$ ]]; then WATCH=$2; shift; fi ;;
		-h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) REPOS+=("$1") ;;
	esac
	shift
done
[ ${#REPOS[@]} -eq 0 ] && REPOS=(miroapp-dev/client)
[ -t 1 ] || [ "$COLOR" = 2 ] || COLOR=0

if [ "$COLOR" = 1 ]; then
	B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'
	GREEN=$'\e[32m'; RED=$'\e[31m'; YEL=$'\e[33m'; BLUE=$'\e[34m'; CYAN=$'\e[36m'; GRAY=$'\e[90m'
else
	B=""; D=""; R=""; GREEN=""; RED=""; YEL=""; BLUE=""; CYAN=""; GRAY=""
fi

QUERY='query($q:String!,$after:String){
  search(query:$q,type:ISSUE,first:50,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{ ... on PullRequest {
      number title url isDraft mergeable updatedAt
      repository{nameWithOwner}
      commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      reviewRequests(first:20){nodes{requestedReviewer{__typename ... on Team{slug} ... on User{login}}}}
      latestReviews(first:30){nodes{author{login} state}}
      reviewThreads(first:100){nodes{isResolved path comments(first:1){nodes{author{login}}}}}
    }}
  }
}'

fetch() {
	local q all after page nodes has
	q="is:pr is:open author:@me"
	for repo in "${REPOS[@]}"; do q="$q repo:$repo"; done
	all='[]'; after=""
	while :; do
		if [ -z "$after" ]; then
			page=$(gh api graphql -f query="$QUERY" -f q="$q") || { echo "gh failed" >&2; break; }
		else
			page=$(gh api graphql -f query="$QUERY" -f q="$q" -f after="$after") || { echo "gh failed" >&2; break; }
		fi
		nodes=$(echo "$page" | jq '[.data.search.nodes[] | select(.number != null) | . + {repo:.repository.nameWithOwner}]')
		all=$(jq -n --argjson a "$all" --argjson b "$nodes" '$a + $b')
		has=$(echo "$page" | jq -r '.data.search.pageInfo.hasNextPage')
		[ "$has" = "true" ] || break
		after=$(echo "$page" | jq -r '.data.search.pageInfo.endCursor')
	done
	echo "$all" | jq '
	  map({
	    repo, number, title, url, isDraft, mergeable, updatedAt,
	    ci: (.commits.nodes[0].commit.statusCheckRollup.state // "NONE"),
	    approvals: [.latestReviews.nodes[] | select(.state=="APPROVED") | .author.login],
	    changesRequested: [.latestReviews.nodes[] | select(.state=="CHANGES_REQUESTED") | .author.login],
	    pendingTeams: [.reviewRequests.nodes[].requestedReviewer | select(.__typename=="Team") | .slug],
	    pendingUsers: [.reviewRequests.nodes[].requestedReviewer | select(.__typename=="User") | .login],
	    unresolved: [.reviewThreads.nodes[] | select(.isResolved|not) | {path, by: .comments.nodes[0].author.login}]
	  })'
}

strip() { printf '%s' "$1" | sed -E $'s/\x1b\\[[0-9;]*m//g; s/\x1b\\([A-Z0-9]//g; s/\x1b\\]8;;[^\x1b]*\x1b\\\\//g'; }
vlen() { local t; t=$(strip "$1"); printf '%s' "${#t}"; }

trunc() { # trunc <plain text> <width>
	local t=$1 w=$2
	if [ ${#t} -gt "$w" ] && [ "$w" -gt 1 ]; then printf '%s…' "${t:0:$((w-1))}"; else printf '%s' "$t"; fi
}

ago() { # ago <iso8601>
	local then now diff
	then=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s)
	now=$(date +%s); diff=$((now-then))
	if [ $diff -lt 3600 ]; then echo "$((diff/60))m ago"
	elif [ $diff -lt 86400 ]; then echo "$((diff/3600))h ago"
	else echo "$((diff/86400))d ago"; fi
}

# Box drawing. WIDTH is the outer width; inner text width is WIDTH-4.
box_top()    { local title=$1 col=${2:-$GRAY}; local t=" $title "; local fill=$((WIDTH-3-$(vlen "$t"))); [ $fill -lt 0 ] && fill=0; printf '%s╭─%s%s╮%s\n' "$col" "$t" "$(printf '─%.0s' $(seq 1 $fill))" "$R"; }
box_sep()    { local col=${1:-$GRAY}; printf '%s├%s┤%s\n' "$col" "$(printf '─%.0s' $(seq 1 $((WIDTH-2))))" "$R"; }
box_bottom() { local col=${1:-$GRAY}; printf '%s╰%s╯%s\n' "$col" "$(printf '─%.0s' $(seq 1 $((WIDTH-2))))" "$R"; }
box_line()   { # box_line <text with colors> [border color]
	local text=$1 col=${2:-$GRAY} inner=$((WIDTH-4)) plain len pad
	plain=$(strip "$text")
	if [ ${#plain} -gt $inner ]; then text=$(trunc "$plain" "$inner"); fi
	len=$(vlen "$text"); pad=$((inner-len)); [ $pad -lt 0 ] && pad=0
	printf '%s│%s %s%*s %s│%s\n' "$col" "$R" "$text" "$pad" "" "$col" "$R"
}
box_wrap()   { # box_wrap <label> <csv list> [border color]: wraps a comma list onto lines
	local label=$1 list=$2 col=${3:-$GRAY} inner=$((WIDTH-4)) line="" item first=1
	IFS=',' read -ra items <<< "$list"
	line="$label"
	for item in "${items[@]}"; do
		item=$(printf '%s' "$item" | sed 's/^ *//')
		if [ $(( $(vlen "$line") + ${#item} + 2 )) -gt $inner ]; then box_line "$line" "$col"; line="    $item"; else line="$line $item"; fi
	done
	box_line "$line" "$col"
}

link() { # link <url> <text>: OSC 8 hyperlink when colour is on
	if [ "$COLOR" != 0 ]; then printf '\e]8;;%s\e\\%s\e]8;;\e\\' "$1" "$2"; else printf '%s' "$2"; fi
}

render_card() { # render_card <index>; reads one unit-separated record on stdin
	local idx=$1
	local repo number title url draft mergeable updated ci approvals changes teams users nunres unres
	IFS=$'\x1f' read -r repo number title url draft mergeable updated ci approvals changes teams users nunres unres
	local glyph col status
	case "$ci" in
		SUCCESS) glyph="✓"; col=$GREEN; status="CI green" ;;
		FAILURE|ERROR) glyph="✗"; col=$RED; status="CI red" ;;
		PENDING|EXPECTED) glyph="●"; col=$YEL; status="CI running" ;;
		*) glyph="○"; col=$GRAY; status="no CI" ;;
	esac
	[ "$nunres" != 0 ] && col=$RED
	[ "$mergeable" = "CONFLICTING" ] && { col=$RED; status="$status · conflicts"; }
	local head="${col}${glyph}${R} ${B}${repo#*/}#${number}${R}"
	[ "$draft" = "true" ] && head="$head ${GRAY}draft${R}"
	if [ "$WATCH" -gt 0 ] && [ "$idx" -le 9 ]; then
		if [ "$ci" = "FAILURE" ] || [ "$ci" = "ERROR" ]; then head="$head ${GRAY}[${idx}]${R} ${RED}c rerun CI${R} ${GRAY}· n nudge${R}"
		else head="$head ${GRAY}[${idx}] n nudge${R}"; fi
	fi
	box_top "$head" "$col"
	box_line "${B}$(trunc "$title" $((WIDTH-4)))${R}" "$col"
	box_line "${GRAY}$(link "$url" "$(trunc "$url" $((WIDTH-4)))")${R}" "$col"
	box_sep "$col"
	local line="${col}${status}${R} ${GRAY}· $(ago "$updated")${R}"
	if [ -n "$approvals" ]; then line="$line ${GRAY}·${R} ${GREEN}✓ $approvals${R}"; else line="$line ${GRAY}· no approvals${R}"; fi
	box_line "$line" "$col"
	[ -n "$changes" ] && box_line "${RED}✎ changes requested by $changes${R}" "$col"
	if [ -n "$teams" ] || [ -n "$users" ]; then
		[ -n "$teams" ] && box_wrap "${YEL}teams:${R}" "$teams" "$col"
		[ -n "$users" ] && box_wrap "${YEL}users:${R}" "$users" "$col"
	else
		box_line "${GREEN}no pending reviewers${R}" "$col"
	fi
	if [ "$nunres" != 0 ]; then
		box_sep "$col"
		box_wrap "${RED}✎ $nunres unresolved:${R}" "$unres" "$col"
	fi
	box_bottom "$col"
}

render() {
	local report=$1 count cols
	cols=$(tput cols 2>/dev/null || echo "${COLUMNS:-100}"); [ -t 1 ] || cols=${COLUMNS:-100}
	count=$(echo "$report" | jq 'length')
	if [ "$count" = 0 ]; then echo "${D}No open PRs.${R}"; return; fi

	local red unresolved waiting
	red=$(echo "$report" | jq '[.[]|select(.ci=="FAILURE" or .ci=="ERROR")]|length')
	unresolved=$(echo "$report" | jq '[.[]|select((.unresolved|length)>0)]|length')
	waiting=$(echo "$report" | jq '[.[]|select(((.pendingTeams|length)+(.pendingUsers|length))>0)]|length')
	WIDTH=$cols; [ "$WIDTH" -lt 50 ] && WIDTH=50
	box_top "${B}Open pull requests${R}" "$BLUE"
	box_line "${B}$count open${R}   ${RED}✗ $red red CI${R}   ${RED}✎ $unresolved unresolved${R}   ${YEL}◌ $waiting awaiting review${R}   ${GRAY}${REPOS[*]} · $(date +%H:%M)${R}" "$BLUE"
	box_bottom "$BLUE"
	echo

	# grid: as many 64-wide cards as fit, max 3, min 1; cards share the row width evenly
	local gap=2 ncols
	ncols=$(( (cols + gap) / (64 + gap) ))
	[ $ncols -lt 1 ] && ncols=1; [ $ncols -gt 3 ] && ncols=3; [ $ncols -gt "$count" ] && ncols=$count
	WIDTH=$(( (cols - gap * (ncols - 1)) / ncols )); [ "$WIDTH" -gt 110 ] && WIDTH=110; [ "$WIDTH" -lt 50 ] && WIDTH=50

	local tmp; tmp=$(mktemp -d)
	local i=0
	while IFS= read -r rec; do
		printf '%s\n' "$rec" | render_card $((i+1)) > "$tmp/card.$i"
		i=$((i+1))
	done < <(echo "$report" | jq -r '.[] | [.repo,.number,.title,.url,.isDraft,.mergeable,.updatedAt,.ci,(.approvals|join(", ")),(.changesRequested|join(", ")),(.pendingTeams|join(", ")),(.pendingUsers|join(", ")),(.unresolved|length),(.unresolved|map("\(.path|split("/")|last) (\(.by))")|join(", "))] | join("\u001f")')

	local row=0 blank; blank=$(printf '%*s' "$WIDTH" "")
	while [ $((row*ncols)) -lt $i ]; do
		local max=0 c f n
		for ((c=0; c<ncols; c++)); do f="$tmp/card.$((row*ncols+c))"; [ -f "$f" ] || continue; n=$(wc -l < "$f"); [ "$n" -gt $max ] && max=$n; done
		for ((l=1; l<=max; l++)); do
			local out=""
			for ((c=0; c<ncols; c++)); do
				f="$tmp/card.$((row*ncols+c))"
				if [ -f "$f" ]; then line=$(sed -n "${l}p" "$f"); [ -z "$line" ] && line=$blank; else line=$blank; fi
				[ $c -gt 0 ] && out="$out$(printf '%*s' $gap "")"
				out="$out$line"
			done
			printf '%s\n' "$out"
		done
		echo
		row=$((row+1))
	done
	rm -rf "$tmp"
}

slack_handle() { # slack_handle <github team slug, with or without org/>
	local slug=${1##*/} map="$HOME/.config/prs/teams.json"
	if [ -f "$map" ]; then
		local h; h=$(jq -r --arg k "$slug" '.[$k] // empty' "$map")
		[ -n "$h" ] && { printf '%s' "$h"; return; }
	fi
	printf '@%s' "$slug"
}

nudge_message() { # nudge_message <repo> <number>
	local repo=$1 number=$2 pr title url motivation add del teams tags t
	pr=$(gh pr view "$number" --repo "$repo" --json title,url,body,additions,deletions,reviewRequests)
	title=$(echo "$pr" | jq -r .title); url=$(echo "$pr" | jq -r .url)
	add=$(echo "$pr" | jq -r .additions); del=$(echo "$pr" | jq -r .deletions)
	motivation=$(echo "$pr" | jq -r .body | awk '/^### Motivation/{f=1;next} /^###/{if(f)exit} f' | sed '/^\s*$/d' | head -3 | tr '\n' ' ' | sed 's/  */ /g; s/ $//')
	teams=$(echo "$pr" | jq -r '[.reviewRequests[]|select(.__typename=="Team")|.slug]|join(" ")')
	tags=""; for t in $teams; do tags="$tags, $(slack_handle "$t")"; done
	tags=$(printf '%s' "$tags" | sed 's/^, //')
	{
		if [ -n "$tags" ]; then printf 'Hi! %s, could you please review %s\n' "$tags" "$url"
		else printf 'Hi! Could you please review %s\n' "$url"; fi
		printf '%s (+%s/-%s)\n' "$title" "$add" "$del"
		[ -n "$motivation" ] && printf '%s\n' "$motivation"
	}
}

rerun_failed() { # rerun_failed <repo> <number> -> message
	local repo=$1 number=$2 runs r out=""
	runs=$(gh pr checks "$number" --repo "$repo" --json state,link --jq '[.[]|select(.state=="FAILURE")|.link|capture("/runs/(?<id>[0-9]+)/").id]|unique|.[]' 2>/dev/null)
	[ -z "$runs" ] && { printf 'No failed checks on #%s' "$number"; return; }
	for r in $runs; do
		if gh run rerun "$r" --failed --repo "$repo" >/dev/null 2>&1; then out="$out run $r"; else out="$out run $r (rerun refused)"; fi
	done
	printf 'Rerunning failed jobs of #%s:%s' "$number" "$out"
}

nudge() {
	local report repo number choice candidates
	if [ -z "$NUDGE_PR" ]; then
		report=$(fetch)
		candidates=$(echo "$report" | jq -r '.[] | select(((.pendingTeams|length)+(.pendingUsers|length))>0) | "\(.number)\t\(.repo)\t\(.title)\t\((.pendingTeams+.pendingUsers)|join(", "))"')
		if [ -z "$candidates" ]; then echo "${D}Nothing is waiting on a reviewer.${R}"; return; fi
		echo "${B}PRs waiting on reviewers:${R}"
		echo "$candidates" | while IFS=$'\t' read -r n r t pend; do printf '  %s%s%s  %s  %s%s%s\n' "$B" "$n" "$R" "$(trunc "$t" 60)" "$YEL" "$pend" "$R"; done
		printf '%sCopy a Slack review request for which PR? %s' "$YEL" "$R"
		read -r choice </dev/tty
		[[ "$choice" =~ ^[0-9]+$ ]] || { echo "cancelled"; return; }
		NUDGE_PR=$choice
		repo=$(echo "$candidates" | awk -F'\t' -v n="$choice" '$1==n{print $2}')
	fi
	repo=${repo:-${REPOS[0]}}
	local msg; msg=$(nudge_message "$repo" "$NUDGE_PR")
	if command -v pbcopy >/dev/null; then printf '%s\n' "$msg" | pbcopy; echo "${GREEN}Copied to clipboard:${R}"; else echo "${YEL}pbcopy not found, message:${R}"; fi
	printf '%s%s%s\n' "$D" "$msg" "$R"
}

run_once() {
	local report
	if [ -t 2 ] && [ "$JSON" = 0 ]; then printf '%sfetching %s…%s' "$D" "${REPOS[*]}" "$R" >&2; fi
	report=$(fetch)
	if [ -t 2 ] && [ "$JSON" = 0 ]; then printf '\r\033[K' >&2; fi
	if [ "$JSON" = 1 ]; then echo "$report"; else render "$report"; fi
}

if [ "$NUDGE" = 1 ]; then
	nudge; exit 0
fi
if [ -n "$RERUN_PR" ]; then
	[[ "$RERUN_PR" =~ ^[0-9]+$ ]] || { echo "usage: prs rerun <PR-number>" >&2; exit 2; }
	rerun_failed "${REPOS[0]}" "$RERUN_PR"; echo; exit 0
fi

if [ "$WATCH" -gt 0 ]; then
	trap 'printf "\e[?25h"; exit 0' INT TERM
	printf '\e[?25l'
	LAST_REPORT='[]'; TOAST=""
	while :; do
		LAST_REPORT=$(fetch 2>/dev/null)
		clear
		render "$LAST_REPORT"
		printf '%srefresh every %ss · %s[1-9]%s then %sn%s copy Slack nudge or %sc%s rerun failed CI · %sr%s refresh · %sq%s quit%s\n' "$GRAY" "$WATCH" "$B" "$GRAY" "$B" "$GRAY" "$B" "$GRAY" "$B" "$GRAY" "$B" "$GRAY" "$R"
		[ -n "$TOAST" ] && { printf '%s%s%s\n' "$GREEN" "$TOAST" "$R"; TOAST=""; }
		key=""
		if [ -t 0 ]; then
			read -r -s -n 1 -t "$WATCH" key </dev/tty || key=""
		else
			sleep "$WATCH"
		fi
		case "$key" in
			q) printf '\e[?25h'; exit 0 ;;
			r|"") ;;
			[1-9])
				sel=$(echo "$LAST_REPORT" | jq -r --argjson i "$((key-1))" '.[$i] // empty | "\(.repo)\t\(.number)"')
				[ -z "$sel" ] && continue
				sel_repo=${sel%	*}; sel_pr=${sel#*	}
				printf '%s#%s: %sn%s nudge · %sc%s rerun failed CI%s ' "$GRAY" "$sel_pr" "$B" "$GRAY" "$B" "$GRAY" "$R"
				action=""; read -r -s -n 1 -t 10 action </dev/tty || action=""
				case "$action" in
					n) msg=$(nudge_message "$sel_repo" "$sel_pr")
					   if command -v pbcopy >/dev/null; then printf '%s\n' "$msg" | pbcopy; TOAST="Copied Slack nudge for #$sel_pr: $(printf '%s' "$msg" | head -1 | cut -c1-100)"; else TOAST="pbcopy not found"; fi ;;
					c) printf '\r%srequesting rerun for #%s…%s' "$YEL" "$sel_pr" "$R"
					   TOAST=$(rerun_failed "$sel_repo" "$sel_pr")
					   sleep 3 ;;
					*) ;;
				esac ;;
		esac
	done
else
	run_once
fi
