#!/bin/bash
# export_template.sh
# This script creates a template snapshot of your perfectly configured Twenty CRM database.

set -e

echo "📦 Exporting Twenty CRM Database Template..."

# We assume the local database container is named 'twenty-db-1'
# and the postgres user is 'postgres' and database is 'default'
DB_CONTAINER="twenty-db-1"
DB_USER="postgres"
DB_NAME="default"

OUTPUT_FILE="twenty_template.sql"

# Run pg_dump inside the container (removed -c flag to prevent DROP statements crashing the init)
docker exec -t $DB_CONTAINER pg_dump -U $DB_USER -d $DB_NAME -O -x > $OUTPUT_FILE

echo "✅ Successfully exported to $OUTPUT_FILE!"
echo "Note: This template includes your dummy leads. When spinning up a new clinic, you can simply delete the dummy leads from the UI."
