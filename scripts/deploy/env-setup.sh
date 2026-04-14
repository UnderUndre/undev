#!/bin/bash
# ─────────────────────────────────────────────────
# Create or update .env files from .env.example.
#
# Reads .env.example, prompts for each value (showing
# defaults), writes to the selected target file.
# Existing values in the target are preserved as defaults.
#
# Usage:
#   ./scripts/deploy/env-setup.sh                    # Interactive: pick target file
#   ./scripts/deploy/env-setup.sh .env                # Create/update .env
#   ./scripts/deploy/env-setup.sh .env.production     # Create/update .env.production
#   ./scripts/deploy/env-setup.sh --non-interactive   # Use defaults, no prompts
#   ./scripts/deploy/env-setup.sh --diff              # Show diff between example and target
#
# Flags:
#   --app-dir <path>   Override app directory (default: repo root)
#   --example <file>   Override example file (default: .env.example)
#   --generate-secrets Auto-generate empty secret values
# ─────────────────────────────────────────────────

source "$(dirname "$0")/../common.sh"

# Defaults
APP_DIR="$REPO_ROOT"
EXAMPLE_FILE=".env.example"
TARGET_FILE=""
NON_INTERACTIVE=false
SHOW_DIFF=false
GENERATE_SECRETS=false

# Parse args
while [[ $# -gt 0 ]]; do
    case $1 in
        --app-dir)      APP_DIR="$2"; shift 2 ;;
        --example)      EXAMPLE_FILE="$2"; shift 2 ;;
        --non-interactive) NON_INTERACTIVE=true; shift ;;
        --diff)         SHOW_DIFF=true; shift ;;
        --generate-secrets) GENERATE_SECRETS=true; shift ;;
        -h|--help)
            echo "Usage: env-setup.sh [target] [--app-dir <path>] [--example <file>] [--non-interactive] [--diff] [--generate-secrets]"
            echo ""
            echo "Examples:"
            echo "  env-setup.sh                        # Interactive picker"
            echo "  env-setup.sh .env                   # Target .env"
            echo "  env-setup.sh .env.production        # Target .env.production"
            echo "  env-setup.sh --app-dir devops-app   # Different app directory"
            exit 0 ;;
        -*)
            error "Unknown flag: $1"; exit 1 ;;
        *)
            TARGET_FILE="$1"; shift ;;
    esac
done

EXAMPLE_PATH="$APP_DIR/$EXAMPLE_FILE"

# Ensure app directory exists
if [[ ! -d "$APP_DIR" ]]; then
    mkdir -p "$APP_DIR"
    info "Created directory: $APP_DIR"
fi

# Validate
if [[ ! -f "$EXAMPLE_PATH" ]]; then
    error "Example file not found: $EXAMPLE_PATH"
    info "Create a .env.example in your project first"
    exit 1
fi

# ─────────────────────────────────────────────────
# Target file selection
# ─────────────────────────────────────────────────

if [[ -z "$TARGET_FILE" ]]; then
    echo -e "${BLUE}=== Env File Setup ===${NC}"
    echo ""
    info "Source: $EXAMPLE_PATH"
    echo ""

    # Show existing .env* files
    existing=$(find "$APP_DIR" -maxdepth 1 -name '.env*' ! -name '.env.example' -printf '%f\n' 2>/dev/null | sort)
    if [[ -n "$existing" ]]; then
        info "Existing env files:"
        echo "$existing" | while read -r f; do
            echo -e "  ${GREEN}●${NC} $f"
        done
        echo ""
    fi

    echo "Select target file:"
    echo -e "  ${CYAN}1${NC}) .env"
    echo -e "  ${CYAN}2${NC}) .env.production"
    echo -e "  ${CYAN}3${NC}) .env.staging"
    echo -e "  ${CYAN}4${NC}) .env.local"
    echo -e "  ${CYAN}5${NC}) Custom name"
    echo ""
    read -rp "$(echo -e "${YELLOW}Choice [1]:${NC} ")" choice

    case "${choice:-1}" in
        1) TARGET_FILE=".env" ;;
        2) TARGET_FILE=".env.production" ;;
        3) TARGET_FILE=".env.staging" ;;
        4) TARGET_FILE=".env.local" ;;
        5)
            read -rp "$(echo -e "${YELLOW}File name:${NC} ")" TARGET_FILE
            [[ -z "$TARGET_FILE" ]] && { error "No filename given"; exit 1; }
            ;;
        *) TARGET_FILE=".env" ;;
    esac
fi

TARGET_PATH="$APP_DIR/$TARGET_FILE"

# ─────────────────────────────────────────────────
# Diff mode
# ─────────────────────────────────────────────────

if [[ "$SHOW_DIFF" == "true" ]]; then
    if [[ ! -f "$TARGET_PATH" ]]; then
        warn "$TARGET_FILE does not exist yet"
        info "All variables from $EXAMPLE_FILE are missing"
        exit 0
    fi

    # Extract keys from both files
    example_keys=$(grep -E '^[A-Z_]+=?' "$EXAMPLE_PATH" | cut -d= -f1 | sort)
    target_keys=$(grep -E '^[A-Z_]+=?' "$TARGET_PATH" | cut -d= -f1 | sort)

    missing=$(comm -23 <(echo "$example_keys") <(echo "$target_keys"))
    extra=$(comm -13 <(echo "$example_keys") <(echo "$target_keys"))

    if [[ -z "$missing" ]] && [[ -z "$extra" ]]; then
        log "All keys match between $EXAMPLE_FILE and $TARGET_FILE"
    else
        if [[ -n "$missing" ]]; then
            warn "Missing in $TARGET_FILE (present in $EXAMPLE_FILE):"
            echo "$missing" | while read -r k; do
                echo -e "  ${RED}-${NC} $k"
            done
        fi
        if [[ -n "$extra" ]]; then
            info "Extra in $TARGET_FILE (not in $EXAMPLE_FILE):"
            echo "$extra" | while read -r k; do
                echo -e "  ${CYAN}+${NC} $k"
            done
        fi
    fi
    exit 0
fi

# ─────────────────────────────────────────────────
# Generate random secret
# ─────────────────────────────────────────────────

generate_secret() {
    openssl rand -base64 32 | tr -d '=/+' | head -c 32
}

# ─────────────────────────────────────────────────
# Parse example file and prompt
# ─────────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Setting up $TARGET_FILE ===${NC}"
echo ""

# Load existing target values (if updating)
declare -A existing_values
if [[ -f "$TARGET_PATH" ]]; then
    info "Updating existing $TARGET_FILE"
    while IFS= read -r line; do
        [[ "$line" =~ ^#.*$ ]] && continue
        [[ -z "$line" ]] && continue
        key="${line%%=*}"
        value="${line#*=}"
        existing_values["$key"]="$value"
    done < "$TARGET_PATH"
else
    info "Creating new $TARGET_FILE"
fi
echo ""

# Process example file line by line, preserving structure
output=""
declare -A prompted_keys

while IFS= read -r line; do
    # Pass through empty lines and comments
    if [[ -z "$line" ]] || [[ "$line" =~ ^#.*$ ]]; then
        output+="$line"$'\n'
        continue
    fi

    # Parse KEY=value
    key="${line%%=*}"
    example_value="${line#*=}"

    # Skip if already prompted (duplicate key)
    [[ -n "${prompted_keys[$key]:-}" ]] && continue
    prompted_keys["$key"]=1

    # Determine default: existing value > example value
    default="${existing_values[$key]:-$example_value}"

    # Auto-generate secrets for empty sensitive keys
    if [[ "$GENERATE_SECRETS" == "true" ]] && [[ -z "$default" ]]; then
        case "$key" in
            *PASSWORD*|*SECRET*|*KEY*|*TOKEN*)
                default=$(generate_secret)
                info "Auto-generated: $key"
                ;;
        esac
    fi

    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        # Non-interactive: use default
        output+="$key=$default"$'\n'
    else
        # Interactive: prompt with default
        if [[ -n "$default" ]]; then
            read -rp "$(echo -e "${CYAN}$key${NC} [${default}]: ")" input
            value="${input:-$default}"
        else
            # Highlight required empty vars
            read -rp "$(echo -e "${YELLOW}$key${NC} (empty): ")" input
            value="$input"
        fi
        output+="$key=$value"$'\n'
    fi
done < "$EXAMPLE_PATH"

# ─────────────────────────────────────────────────
# Write
# ─────────────────────────────────────────────────

echo ""

# Backup existing
if [[ -f "$TARGET_PATH" ]]; then
    backup="${TARGET_PATH}.bak.$(date '+%Y%m%d_%H%M%S')"
    cp "$TARGET_PATH" "$backup"
    step "Backed up existing to $(basename "$backup")"
fi

echo "$output" > "$TARGET_PATH"
log "Written: $TARGET_PATH"

# Summary
key_count=$(grep -cE '^[A-Z_]+=?' "$TARGET_PATH" 2>/dev/null || echo 0)
empty_count=$(grep -cE '^[A-Z_]+=$' "$TARGET_PATH" 2>/dev/null || echo 0)

echo ""
info "Keys: $key_count total, $empty_count empty"

if [[ $empty_count -gt 0 ]]; then
    warn "Empty values:"
    grep -E '^[A-Z_]+=$' "$TARGET_PATH" | cut -d= -f1 | while read -r k; do
        echo -e "  ${YELLOW}○${NC} $k"
    done
    echo ""
    info "Fill them in: ${CYAN}nano $TARGET_PATH${NC}"
fi

log "Done!"
