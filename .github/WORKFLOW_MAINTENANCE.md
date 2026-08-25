# Scheduled workflow maintenance

The `Daily autopublish` workflow runs every day at 08:12 Europe/Istanbul
(05:12 UTC) from the default branch.

GitHub may automatically disable scheduled workflows in public repositories
after 60 days without repository activity. If the workflow is disabled, enable
it again from **Actions → Daily autopublish → Enable workflow**. A repository
maintenance commit also renews repository activity.

Before changing or manually running the workflow:

1. Run `npm run check` and `npm test`.
2. Prefer a dry run when validating autopublisher behavior.
3. Confirm that production CMS writes and publishing are intentional.
