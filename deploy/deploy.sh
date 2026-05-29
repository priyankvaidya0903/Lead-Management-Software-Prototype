#!/bin/bash
# deploy.sh
# This script deploys a fresh cloned Twenty CRM instance using the exported template.

set -e

CLINIC_NAME=$1

if [ -z "$CLINIC_NAME" ]; then
  echo "❌ Error: You must provide a clinic name."
  echo "Usage: ./deploy.sh \"Downtown Clinic\" [optional_custom_domain.com]"
  exit 1
fi

CUSTOM_DOMAIN=$2

# Clean up formatting for subdomain/folder creation
CLINIC_SLUG=$(echo "$CLINIC_NAME" | tr '[:upper:]' '[:lower:]' | tr -s ' ' '-')

echo "🚀 Deploying new isolated Twenty CRM instance for: $CLINIC_NAME ($CLINIC_SLUG)"

# 1. Create a deployment directory for this specific clinic
DEPLOY_DIR="/opt/twentycrm/$CLINIC_SLUG"
mkdir -p "$DEPLOY_DIR"

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# 2. Copy the production Docker Compose and the Database Template
cp "$SCRIPT_DIR/docker-compose.prod.yml" "$DEPLOY_DIR/"
cp "$ROOT_DIR/twenty_template.sql" "$DEPLOY_DIR/"

# 3. Generate a secure random encryption key for this clinic's CRM
ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
APP_SECRET=$(openssl rand -base64 32 | tr -d '\n')

# 4. Determine the SERVER_URL
if [ -n "$CUSTOM_DOMAIN" ]; then
  FINAL_SERVER_URL="https://$CUSTOM_DOMAIN"
else
  # If no domain is provided, grab the public IP of the machine
  PUBLIC_IP=$(curl -s ifconfig.me || echo "localhost")
  FINAL_SERVER_URL="http://$PUBLIC_IP:3000"
  echo "⚠️ No domain provided. Falling back to Public IP: $FINAL_SERVER_URL"
fi

# 5. Generate the .env file
cat <<EOF > "$DEPLOY_DIR/.env"
# Environment configuration for $CLINIC_NAME
SERVER_URL=$FINAL_SERVER_URL
PG_DATABASE_PASSWORD=secure_postgres_pass_123
ENCRYPTION_KEY=$ENCRYPTION_KEY
APP_SECRET=$APP_SECRET
EOF

# 5. Boot it up!
cd "$DEPLOY_DIR"
echo "⏳ Spinning up containers..."
docker compose -f docker-compose.prod.yml up -d

echo "✅ Success!"
echo "--------------------------------------------------------"
echo "🌐 CRM URL: $FINAL_SERVER_URL"
echo "🛠️ Action Required:"
if [ -z "$CUSTOM_DOMAIN" ]; then
  echo "1. Log into the CRM at $FINAL_SERVER_URL"
else
  echo "1. Create a DNS A-Record pointing $CUSTOM_DOMAIN to this server's IP."
  echo "2. Log into the CRM at $FINAL_SERVER_URL"
fi
echo "3. Go to Settings -> Workflows."
echo "4. Update the Webhook URL to point to your new microservice instance."
echo "--------------------------------------------------------"
