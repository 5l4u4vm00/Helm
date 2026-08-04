#!/bin/sh
# Helm statusline forwarder: relay Claude Code's statusline JSON to Helm
# (cost / context usage), then print a compact status line.
json=$(cat)
if [ -n "$HELM_EVENT_PORT" ]; then
  printf '%s' "$json" | curl -s -m 2 -X POST \
    "http://127.0.0.1:$HELM_EVENT_PORT/hook?session=$HELM_SESSION_ID&source=claude-code-statusline" \
    --data-binary @- >/dev/null 2>&1
fi
model=$(printf '%s' "$json" | sed -n 's/.*"display_name" *: *"\([^"]*\)".*/\1/p')
cost=$(printf '%s' "$json" | sed -n 's/.*"total_cost_usd" *: *\([0-9.]*\).*/\1/p')
left=$(printf '%s' "$json" | sed -n 's/.*"remaining_percentage" *: *\([0-9.]*\).*/\1/p')
line="${model:-Claude}"
[ -n "$cost" ] && line="$line \$$cost"
[ -n "$left" ] && line="$line ${left}% left"
printf '%s' "$line"
