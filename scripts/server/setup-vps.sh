#!/bin/bash
# ─────────────────────────────────────────────────
# Fresh VPS setup: deploy user, SSH hardening, swap, firewall.
#
# Run as root on a fresh Ubuntu/Debian VPS:
#   curl -sL https://raw.githubusercontent.com/UnderUndre/undev/main/scripts/server/setup-vps.sh | bash -s -- <deploy_user>
#
# Or locally:
#   ssh root@<server> < scripts/server/setup-vps.sh
# ─────────────────────────────────────────────────

set -euo pipefail

DEPLOY_USER="${1:-deploy}"
SWAP_SIZE="${2:-2G}"

echo "=== VPS Setup ==="
echo "Deploy user: $DEPLOY_USER"
echo "Swap size:   $SWAP_SIZE"
echo ""

# 1. System updates
echo "▸ Updating system..."
apt-get update -qq && apt-get upgrade -y -qq

# 2. Essential packages
echo "▸ Installing essentials..."
apt-get install -y -qq \
    curl wget git unzip htop \
    ufw fail2ban \
    nginx certbot python3-certbot-nginx

# 3. Create deploy user
if ! id "$DEPLOY_USER" &>/dev/null; then
    echo "▸ Creating user: $DEPLOY_USER"
    adduser --disabled-password --gecos "" "$DEPLOY_USER"
    usermod -aG sudo "$DEPLOY_USER"
    echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$DEPLOY_USER"
fi

# 4. SSH hardening
echo "▸ Hardening SSH..."
mkdir -p "/home/$DEPLOY_USER/.ssh"
chmod 700 "/home/$DEPLOY_USER/.ssh"

# Copy root authorized_keys to deploy user if exists
if [[ -f /root/.ssh/authorized_keys ]]; then
    cp /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/"
    chown -R "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
fi

# Disable root login and password auth
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# 5. Firewall
echo "▸ Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 'Nginx Full'
ufw --force enable

# 6. Swap
if ! swapon --show | grep -q /swapfile; then
    echo "▸ Creating ${SWAP_SIZE} swap..."
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl vm.swappiness=10
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

# 7. Node.js via nvm (for deploy user)
echo "▸ Installing Node.js 20..."
su - "$DEPLOY_USER" -c '
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm alias default 20
    npm i -g pm2
'

echo ""
echo "=== VPS Setup Complete ==="
echo "SSH as: ssh $DEPLOY_USER@<server-ip>"
echo "Next: copy your SSH key to /home/$DEPLOY_USER/.ssh/authorized_keys"
