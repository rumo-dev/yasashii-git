#!/bin/bash
# テスト用の偽 gh（本物のGitHubには接続しない）。ログイン状態は $FAKE_GH_STATE ファイルの有無で表す。
S="${FAKE_GH_STATE:?}"; R="${FAKE_GH_REMOTES:?}"
case "$1" in
  --version) echo "gh version 9.9.9 (fake)"; exit 0;;
  auth)
    case "$2" in
      token) [ -f "$S" ] && { echo faketoken; exit 0; } || exit 1;;
      status) [ -f "$S" ] && { echo "Logged in to github.com account tester"; exit 0; } || { echo "You are not logged into any GitHub hosts. To get started with GitHub CLI, please run:  gh auth login" >&2; exit 1; };;
      setup-git) exit 0;;
      logout) rm -f "$S"; exit 0;;
      login)
        echo "$*" > "$S.loginargs"
        if [[ " $* " == *" --web "* ]]; then echo "! First copy your one-time code: ABCD-1234"; read -r _; sleep 1; touch "$S"; exit 0; fi
        read -r _; touch "$S"; exit 0;;
    esac;;
  api)
    shift; method=GET; path=""; jq=""
    while [ $# -gt 0 ]; do case "$1" in -X) method="$2"; shift 2;; --jq) jq=1; shift 2;; -f) shift 2;; --paginate) shift;; *) [ -z "$path" ] && path="$1"; shift;; esac; done
    path="${path%%\?*}"
    case "$path" in
      user) if [ -n "$jq" ]; then echo tester; else echo '{"login":"tester","id":4242,"name":"テスト 太郎"}'; fi;;
      user/repos) echo '{"nameWithOwner":"tester/alpha","description":"自分の","isPrivate":true,"url":"https://github.com/tester/alpha","updatedAt":"2026-10-01T00:00:00Z","isFork":false,"permission":"admin","owner":"tester"}'
                  echo '{"nameWithOwner":"team-org/shared","description":"チームのもの","isPrivate":true,"url":"https://github.com/team-org/shared","updatedAt":"2026-10-02T00:00:00Z","isFork":false,"permission":"write","owner":"team-org"}';;
      notifications)
        if [ "$method" = GET ]; then [ -f "$S.notes" ] && cat "$S.notes"; else rm -f "$S.notes"; fi;;
      notifications/threads/*) [ "$method" = PATCH ] && { id="${path##*/}"; [ -f "$S.notes" ] && grep -v "\"id\": *\"$id\"" "$S.notes" > "$S.notes.tmp"; mv -f "$S.notes.tmp" "$S.notes" 2>/dev/null; };;
      user/repository_invitations)
        if [ "$method" = GET ]; then [ -f "$S.inv" ] && echo '{"id":7,"repo":"team-org/invited","url":"https://github.com/team-org/invited","inviter":"boss","role":"write","createdAt":"2026-10-19T00:00:00Z"}'
        fi;;
      user/repository_invitations/7) if [ "$method" = PATCH ]; then rm -f "$S.inv"; touch "$S.accepted"; else rm -f "$S.inv"; fi;;
      repos/*/collaborators) echo '{"login":"tester","url":"https://github.com/tester","role":"admin"}'; [ -f "$S.member" ] && echo '{"login":"taro","url":"https://github.com/taro","role":"write"}';;
      repos/*/collaborators/*)
        u="${path##*/}"
        if [ "$method" = PUT ]; then [ "$u" = "nobody-x" ] && { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }; echo "$u" >> "$S.sent"; echo '{"id": 5}'; else rm -f "$S.member"; fi;;
      repos/*/invitations) [ -f "$S.sent" ] && while read -r u; do echo "{\"id\":5,\"login\":\"$u\",\"role\":\"write\",\"createdAt\":\"2026-10-20T00:00:00Z\"}"; done < "$S.sent";;
      repos/*/invitations/*) rm -f "$S.sent";;
      *) echo "fake gh: unsupported api $path" >&2; exit 1;;
    esac; exit 0;;
  release)
    case "$2" in
      list) printf '['; sep=""; [ -f "$S.reltags" ] && while read -r t; do printf '%s{"tagName":"%s","name":"%s","isDraft":false,"isPrerelease":false,"isLatest":true,"publishedAt":"2026-10-21T00:00:00Z","createdAt":"2026-10-21T00:00:00Z"}' "$sep" "$t" "$t"; sep=","; done < "$S.reltags"; echo ']'; exit 0;;
      create)
        t="$3"
        [ -f "$S.reltags" ] && grep -qx "$t" "$S.reltags" && { echo "a release with the same tag name already exists: $t" >&2; exit 1; }
        git ls-remote --tags origin "refs/tags/$t" | grep -q . || { echo "tag $t doesn't exist in the repository" >&2; exit 1; }
        echo "$t" >> "$S.reltags"; echo "$*" >> "$S.rellog"; echo "https://github.com/tester/proj/releases/tag/$t"; exit 0;;
    esac;;
  repo)
    case "$2" in
      view)
        ref="$3"; [[ "$ref" == --* ]] && ref=""
        if [ -z "$ref" ]; then u=$(git remote get-url origin 2>/dev/null) || { echo "no git remotes found" >&2; exit 1; }; ref="tester/$(basename "$u" .git)"; fi
        case "$ref" in
          tester/*|team-org/shared) echo "{\"nameWithOwner\":\"$ref\",\"url\":\"https://github.com/$ref\",\"viewerPermission\":\"WRITE\",\"isPrivate\":true}"; exit 0;;
          *) echo "Could not resolve to a Repository with the name '$ref'." >&2; exit 1;;
        esac;;
      list) echo '[{"nameWithOwner":"tester/alpha","description":"最初のプロジェクト","isPrivate":true,"url":"https://github.com/tester/alpha","updatedAt":"2026-10-01T00:00:00Z","isFork":false},{"nameWithOwner":"tester/beta-site","description":"","isPrivate":false,"url":"https://github.com/tester/beta-site","updatedAt":"2026-09-01T00:00:00Z","isFork":false}]'; exit 0;;
      create)
        name="$3"; git init -q --bare "$R/$name.git" && git remote add origin "$R/$name.git" && echo "https://github.com/tester/$name"; exit 0;;
    esac;;
esac
echo "fake gh: unsupported: $*" >&2; exit 1
