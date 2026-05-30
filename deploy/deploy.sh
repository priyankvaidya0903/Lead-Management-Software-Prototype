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

# 2. Copy the production Docker Compose, the Database Template, and the API Service
cp "$SCRIPT_DIR/docker-compose.prod.yml" "$DEPLOY_DIR/"
cp "$ROOT_DIR/twenty_template.sql" "$DEPLOY_DIR/"
cp -r "$ROOT_DIR/twenty-crm/api-service" "$DEPLOY_DIR/"

# 3. Use the MASTER encryption keys so the cloned database can be decrypted!
# If you generate new keys, the cloned user accounts and workspaces will break.
ENCRYPTION_KEY="S2N9z7kLq+JcT9rVb4hYm1WpXd6vQoZtH8j3fM0eCxU="
APP_SECRET="S2N9z7kLq+JcT9rVb4hYm1WpXd6vQoZtH8j3fM0eCxU="

# 4. Determine the SERVER_URL
if [ -n "$CUSTOM_DOMAIN" ]; then
  FINAL_SERVER_URL="https://$CUSTOM_DOMAIN"
else
  # If no domain is provided, grab the public IP of the machine
  PUBLIC_IP=$(curl -s ifconfig.me || echo "localhost")
  FINAL_SERVER_URL="http://$PUBLIC_IP:3000"
  echo "⚠️ No domain provided. Falling back to Public IP: $FINAL_SERVER_URL"
fi

# 5. Generate the .env file for Twenty CRM
cat <<EOF > "$DEPLOY_DIR/.env"
# Environment configuration for $CLINIC_NAME
SERVER_URL=$FINAL_SERVER_URL
PG_DATABASE_PASSWORD=secure_postgres_pass_123
ENCRYPTION_KEY=$ENCRYPTION_KEY
APP_SECRET=$APP_SECRET
EOF

# 6. Setup the API Service .env
echo "TWENTY_API_URL=http://server:3000/rest" >> "$DEPLOY_DIR/api-service/.env"
echo "TWENTY_WORKFLOW_WEBHOOK_URL=http://api-service:3002/api/webhooks/whatsapp" >> "$DEPLOY_DIR/api-service/.env"
echo "REDIS_URL=redis://redis:6379" >> "$DEPLOY_DIR/api-service/.env"

# 7. Boot it up!
cd "$DEPLOY_DIR"
echo "⏳ Spinning up containers..."
docker-compose -f docker-compose.prod.yml up -d --build

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
