# Demo 6: who's talking about a project, from five sites at once. Run through docs/demos/record.sh.
Output docs/demos/mentions.gif
Output docs/demos/mentions.txt
Set Shell bash
Set FontFamily "Menlo"
Set FontSize 16
Set Width 1080
Set Height 640
Set Padding 20
Set TypingSpeed 20ms
Set WaitPattern /\$$/
Set WaitTimeout 120s

# Off-screen: an empty state dir; examples/ import this checkout's build (record.sh builds it).
Hide
Type `export PS1='$ ' D=/tmp/api-anything-demo; export API_ANYTHING_HOME=$D/home-mentions; rm -rf "$API_ANYTHING_HOME"; cd "$DEMO_REPO"; clear`
Enter
Wait
Sleep 500ms
Show

Type "# Demo 6: who's talking about duckdb? HN, Reddit, YouTube, GitHub, Mastodon. Empty home. Live." Enter
Type "time node examples/mentions.mjs duckdb --limit 10" Enter
Wait
Sleep 6s
Screenshot docs/demos/mentions.png
Sleep 1s
