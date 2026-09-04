#!/usr/bin/env bash
# One-time GitHub setup for the Say Again repository.
#
# Usage:  OWNER=sayagain-dev REPO=sayagain ./scripts/github-setup.sh
#
# Prerequisites:
#   - gh CLI authenticated with a token that can administer the repository.
#   - The organisation already exists. gh cannot create organisations; make
#     it at https://github.com/organizations/plan first, or run with
#     OWNER=<your-username> and transfer the repository later.
#   - Run from the repository root after the first commit exists.
set -euo pipefail

OWNER="${OWNER:-sayagain-dev}"
REPO="${REPO:-sayagain}"

echo "==> creating $OWNER/$REPO and pushing main"
gh repo create "$OWNER/$REPO" --public --source=. --remote=origin --push \
  --description "The commitment boundary for agent tool calls: queue, hold, repair, dead-letter and replay MCP tool calls with intent attached." \
  --homepage "https://sayagain.sh"

echo "==> merge policy, features, topics"
gh repo edit "$OWNER/$REPO" \
  --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
  --delete-branch-on-merge --enable-discussions --enable-issues --enable-wiki=false \
  --default-branch main \
  --add-topic mcp --add-topic model-context-protocol --add-topic ai-agents \
  --add-topic proxy --add-topic dead-letter-queue --add-topic reliability

echo "==> security features"
gh api -X PATCH "repos/$OWNER/$REPO" --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"},"dependabot_security_updates":{"status":"enabled"}}}
JSON
gh api -X PUT "repos/$OWNER/$REPO/vulnerability-alerts"
gh api -X PUT "repos/$OWNER/$REPO/private-vulnerability-reporting"
gh api -X PATCH "repos/$OWNER/$REPO/code-scanning/default-setup" -f state=configured -f query_suite=default

echo "==> branch ruleset for main"
gh api -X POST "repos/$OWNER/$REPO/rulesets" --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "check" }, { "context": "DCO" } ] } }
  ]
}
JSON

echo "==> done. Next: add a repository secret NPM_TOKEN before the first release."
