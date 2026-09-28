# [mock-cluster] keep the mock PATH across login shells (`bash -l`)
[ -n "$FOUNDRY_MOCK_PATH" ] && export PATH="$FOUNDRY_MOCK_PATH"
export HOME="${FOUNDRY_HOME:-$HOME}"

# [mock-cluster] `module` — the Foundry Lab mock module system (Task 25-c).
# The tutorial's `module load alphafold2` lands here. The module bin dir is
# baked in as an ABSOLUTE path (resolved against the mock fs root at
# file-generation time) so the PATH entry survives any later `cd` — the
# app's node scripts source this profile, load the module, THEN cd into the
# job workdir before calling run_alphafold.py.
module() {
  case "${1:-}" in
    load)
      case "${2:-}" in
        alphafold2)
          case ":$PATH:" in
            *":/home/z/my-project/mini-services/mock-cluster/fs/opt/alphafold2/bin:"*)
              ;; # already loaded — keep PATH idempotent
            *)
              export PATH="/home/z/my-project/mini-services/mock-cluster/fs/opt/alphafold2/bin:$PATH"
              ;;
          esac
          export FOUNDRY_MOCK_MODULES="${FOUNDRY_MOCK_MODULES:+$FOUNDRY_MOCK_MODULES:}alphafold2"
          echo "Loading alphafold2 (mock module)"
          ;;
        *)
          echo "module: unknown $*" >&2
          return 1
          ;;
      esac
      ;;
    list)
      if [ -n "${FOUNDRY_MOCK_MODULES:-}" ]; then
        echo "Currently loaded modules:"
        local __fl_m
        local __fl_i=1
        local __fl_ifs="$IFS"
        IFS=":"
        for __fl_m in $FOUNDRY_MOCK_MODULES; do
          echo "  $__fl_i) $__fl_m (mock)"
          __fl_i=$((__fl_i + 1))
        done
        IFS="$__fl_ifs"
      else
        echo "No modules loaded"
      fi
      ;;
    *)
      echo "module: unknown $*" >&2
      return 1
      ;;
  esac
}
