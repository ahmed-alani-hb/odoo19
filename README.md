# Odoo Custom Add-ons (Honey Bird)

A standalone repository of custom Odoo add-ons, structured so it can be attached
to **any Odoo.sh project** (or any Odoo instance) — either as a **git submodule**
or by merging/copying the module folders in. Modules live at the **root** of this
repository, which is exactly what Odoo.sh expects.

> **Odoo version:** the `main` branch targets **Odoo 19.0**. If you run several
> Odoo versions, keep one branch per version (e.g. `17.0`, `18.0`, `19.0`) and
> point each Odoo.sh project at the matching branch.
>
> **Extra Python dependencies:** none. (If a module ever needs pip packages, add
> them to a `requirements.txt` at the root of this repo — Odoo.sh installs it
> automatically on build.)

## Modules in this repository

| Module | Summary |
|---|---|
| [`pos_restaurant_robustness`](pos_restaurant_robustness/README.md) | Hardens POS restaurant kitchen printing (no missed/duplicate tickets) and adds a *Kitchen Diagnostics* event log + tests to verify stability. Removable; patches only via `patch()`/`_inherit`. |

---

## Use it with Odoo.sh

Odoo.sh builds your instance from your **project's Git repository**. There are two
supported ways to bring these add-ons in.

### Option A — Git submodule (recommended, reusable across projects)

Odoo.sh automatically adds the directories of your submodules to the add-ons path,
and detects modules located at the **root** of each submodule. So you add this
repo once per project and get every module in it.

In a local clone of your **Odoo.sh project** repository, on the branch you deploy
(e.g. `19.0` / `main` / `production`):

```bash
# Public repo (HTTPS):
git submodule add -b main https://github.com/<your-org>/odoo-custom-addons.git odoo-custom-addons

git commit -m "Add Honey Bird custom add-ons as a submodule"
git push
```

Pushing triggers an Odoo.sh build. Then, in the instance:
**activate developer mode → Apps → Update Apps List → install
“POS Restaurant Kitchen Printing Robustness”.**

> **Private submodule?** Odoo.sh needs read access to it. In your Odoo.sh project,
> open **Settings → Submodules / Deploy keys**, copy the project’s public deploy
> key, and add it as a **deploy key** on this add-ons repository (GitHub →
> *Settings → Deploy keys*). Use the SSH URL when adding the submodule:
> `git submodule add -b main git@github.com:<your-org>/odoo-custom-addons.git odoo-custom-addons`.
>
> **Keep the submodule on the right branch** for each project version. To update
> later: `git submodule update --remote odoo-custom-addons && git commit -am "bump custom add-ons" && git push`.

### Option B — Merge / copy (one-off)

If you don’t want a submodule, copy the module folder(s) into your project repo
(at the repo root, or wherever your add-ons path points), commit and push:

```bash
cp -r odoo-custom-addons/pos_restaurant_robustness /path/to/your-odoosh-project/
cd /path/to/your-odoosh-project
git add pos_restaurant_robustness && git commit -m "Add pos_restaurant_robustness" && git push
```

You can also `git remote add custom <this-repo-url>` and `git merge` it, but a
straight copy is simplest since the module already sits at the repo root.

---

## Use it on a self-hosted / Docker / source install

Add this repository's root to your `addons_path`:

```
addons_path = /path/to/odoo/addons,/path/to/odoo-custom-addons
```

Then restart Odoo with `-u` or install the module from **Apps**.

---

## Testing

```bash
# Browser-independent tests (event-log model + concurrency simulator)
odoo-bin -d <db> -u pos_restaurant_robustness --test-enable --stop-after-init \
  --test-tags=/pos_restaurant_robustness:TestSyncConcurrencySim,/pos_restaurant_robustness:TestPosOrderEventModel

# Full suite incl. UI tours (requires a headless browser, e.g. on Odoo.sh staging)
odoo-bin -d <db> -u pos_restaurant_robustness --test-enable --stop-after-init \
  --test-tags=/pos_restaurant_robustness
```

## License

LGPL-3. See [LICENSE](LICENSE).
