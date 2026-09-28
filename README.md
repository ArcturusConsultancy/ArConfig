# ConfigSnapshot — MERN Version

ConfigSnapshot exports Oracle Fusion Cloud setup configuration into combined Excel workbooks.

It also compares the same selected configuration across two saved environments using normalized, stable business keys and produces field-level Excel reports.

- Select an Oracle setup or choose All Setups.
- Select a functional area from that setup.
- Choose Required Tasks or All Tasks.
- Automatically load Oracle setup tasks for the selected functional area.
- Run one extraction request.
- Download one workbook containing Overview, Task Summary, and one sheet per task.
- If a task exports multiple CSV business objects, all files are written as sections in that task's sheet.
- Parent-child category exports include a customer view with one column per hierarchy level; original Oracle CSV sections remain available below it.
- Specialized REST extractors retain every attribute returned by Oracle. Readable mapped columns appear first and additional API attributes are appended automatically.

## Prerequisites

- Node.js 18+
- MongoDB locally or through Atlas
- An Oracle Fusion integration user with:
  - `ORA_ASM_FUNCTIONAL_SETUPS_USER_ABSTRACT`
  - task-specific application administrator privileges
  - CSV export support for the selected setup tasks
  - Inventory REST access when using Configure Subinventories or Manage Inventory Organizations
  - HCM organization/location read access for optional address and location-name enrichment

## Backend

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

The browser login page can supply the Fusion URL, username, and password, so Fusion credentials are optional in `.env`.

```env
PORT=5050
MONGODB_URI=mongodb://localhost:27017/configsnapshot
FUSION_BASE_URL=https://your-instance.oraclecloud.com
FUSION_USERNAME=your_integration_user
FUSION_PASSWORD=your_password
FUSION_ORG_CODES=ALL
PAGE_SIZE=500
TASK_EXPORT_POLL_MS=5000
TASK_EXPORT_TIMEOUT_MS=600000
CREDENTIAL_ENCRYPTION_KEY=replace_with_a_random_secret_at_least_32_chars
CORS_ORIGINS=http://localhost:3000
```

In local development, a private `backend/.credential-key` is generated automatically if `CREDENTIAL_ENCRYPTION_KEY` is omitted. Production deliberately requires the environment variable. The key and `.env` are ignored by Git.

`FUSION_ORG_CODES` is only used by organization-scoped extractors such as Configure Subinventories and Manage Inventory Organizations. The website can override it for each run.

## Frontend

```bash
cd frontend
npm install
npm start
```

Open `http://localhost:3000`, sign in, and open Configuration Snapshot. Select a setup to load its functional areas, or choose All Setups to browse every functional area. Selecting a functional area automatically loads and selects its available exportable tasks. Review the selection and generate the workbook.

To compare environments:

1. Open Settings and save at least two Oracle environments (for example DEV and UAT).
2. Test each saved connection.
3. Open Config Compare and select the source and target environments.
4. For a focused comparison, select a setup, functional area, and configuration items, then run the selected comparison.
5. To compare a complete setup, select the setup and choose **Compare Complete Setup**. To compare every setup, choose **All Setups** and **Compare All Setups**.
6. Complete comparisons download as a ZIP containing one folder per setup and one comparison workbook per functional area. Use **Clear Selection** to deselect all tasks in focused Compare or Migration workflows.

### Automated Config Migration

The application can reuse the original Oracle CSV export package and submit it to the destination through Oracle's Setup Task CSV Import REST API. You do not need to download a package from Oracle and upload it manually.

1. Generate a **new Config Snapshot** using **Generate Selected Workbook**. New snapshots privately retain the original Oracle ZIP packages required for import.
2. Save and test the destination Oracle environment under **Settings**.
3. Open **Config Migration**, choose **Existing Extraction**, and select a source marked **Automation ready**.
4. Select the destination, matching setup/functional area, and the configuration tasks to migrate.
5. Select **Validate & Preview**. The application extracts the destination, compares it with the source, and asks Oracle whether each selected task supports CSV import.
6. Review and download the migration report. If validation is ready, enter the displayed confirmation phrase and execute the migration.
7. The backend uploads each original task package once, polls Oracle until it completes, and records the Oracle process ID and outcome in the report.

Existing snapshots created before this update and manually uploaded Excel workbooks remain preview-only because an Excel workbook is not a valid Oracle import package. Generate a fresh snapshot to make it automation ready. Complete-setup ZIP downloads are also report bundles, not migration sources; use the selected-workbook snapshot for migration.

Oracle still requires the connected user to have `ORA_ASM_FUNCTIONAL_SETUPS_USER_ABSTRACT` and the task-specific import privileges. Tasks for which Oracle returns `ImportSupportedFlag = false` remain blocked. Production execution remains deliberately disabled until an explicit production approval policy is added.

Saved passwords are AES-256-GCM encrypted, are never returned by the API, and are excluded from logs. Login creates an eight-hour in-memory API session so the browser does not resend the Oracle password for every request.

## Oracle API behavior

The implementation uses Oracle's supported REST resources:

- `features` for setup offerings and functional areas
- `setupTasks` for task metadata and task search
- `setupTaskCSVExports` for asynchronous task setup-data exports
- `setupTaskCSVImports` for validation and asynchronous task setup-data imports
- `subinventories` and child `locators` for the specialized Configure Subinventories extractor
- `inventoryOrganizations` and child `invOrgParameters` for Facilities → Manage Inventory Organizations
- HCM `organizations` and `locations` for optional internal-address and location enrichment

The specialized REST extractors do not use a restrictive output field list. They include every direct REST attribute returned by the connected Fusion release, including newly added and environment-specific attributes. Manage Inventory Organizations combines the parent organization and its inventory parameters into one wide row with manager-friendly headings first. Oracle navigation links are excluded because they are API metadata rather than configuration data.

Oracle's public REST API lists setup offerings, functional areas, and setup tasks separately, but does not expose their membership relationships or the same Required/All indicator shown by the Setup and Maintenance UI. The application therefore combines live task metadata with automatic functional-area matching and extensible exact catalogs. Procurement and Manufacturing and Supply Chain Materials Management setup mappings are included in `backend/src/setupOfferingCatalog.js`. Inventory Management, Facilities, and Suppliers task mappings are included in `backend/src/setupTaskCatalog.js`. Unknown setups gracefully show all functional areas, and selecting any area automatically discovers its matching tasks without requiring manual task search.

## Output and history

Generated workbooks are saved under `backend/output` and downloaded through an authenticated API. MongoDB history records the setup, functional area, task selection mode, per-task results, total records, workbook name, and success/partial/failure status.

Report downloads now use the authenticated `/api/reports/:filename` route and validate report ownership. History stores both `EXTRACT` and `COMPARE` operations, environments, duration, summary, warnings, and output reference. Audit records contain safe metadata only.

## Architecture

The original FSM and specialized REST extractors remain intact. `configurationExtractionService` wraps them for reuse, `normalizationService` converts their tables into a common record format, and `comparisonEngine` performs O(n + m) keyed comparison with `ADDED`, `REMOVED`, `MODIFIED`, and `UNCHANGED` results. Duplicate comparison keys are reported instead of silently overwritten. Configuration-specific keys and rules live in `configurationRegistry`; unknown task schemas receive conservative key inference.

## Verification

```bash
cd backend
npm run lint
npm run typecheck
npm test

cd ../frontend
npm run build
```

Hierarchy tasks such as Manage Supplier Products and Services Category Hierarchy are flattened into readable root-to-leaf paths (`Root Category`, `Level 1 Category`, `Level 2 Category`, and so on) with leaf descriptions and category codes.

Customer-view formatters currently cover:

- lookup tasks as a combined lookup type and lookup value table
- profile-option tasks as option, level, and configured-value rows
- value-set tasks as definitions, permitted values, validation sources, and relationships
- flexfield tasks as contexts, segments, value sets, and validation sections
- material-status tasks as an allowed-transaction matrix plus status details
- unit-of-measure tasks as readable class and conversion tables
- interorganization and intersubinventory tasks as source-to-destination transfer routes
- ABC tasks as grouped class, classification-set, and assignment-group tables

Each recognized task writes one concise customer view using lossless deduplication: every distinct Oracle dataset (for example, lookup type details and lookup codes) appears once in its own readable section, while duplicate representations are removed. Audit metadata such as creation and last-update columns is excluded unless it is part of the configuration itself. Tasks without a recognized structured schema continue to use the generic multi-section source format without dropping columns.

Task failures do not discard successful task data. A partial workbook remains downloadable and includes the error in Task Summary and in that task's sheet.
# ArConfig
