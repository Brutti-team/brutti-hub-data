`meta-sync.yml` belongs in `.github/workflows/meta-sync.yml`.

It is parked here because the account that pushed this branch does not have GitHub's
`workflow` permission, which GitHub requires for adding files under `.github/workflows/`.
Move it there (GitHub web: open the file → edit → change the path, or re-push with a token
that has `workflow` scope) before merging, then delete this folder.
