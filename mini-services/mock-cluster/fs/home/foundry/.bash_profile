# [mock-cluster] keep the mock PATH across login shells (`bash -l`)
[ -n "$FOUNDRY_MOCK_PATH" ] && export PATH="$FOUNDRY_MOCK_PATH"
export HOME="${FOUNDRY_HOME:-$HOME}"
