# Version Control Policy

This document describes how version control and release versioning are
handled in **Avarixen Avatar Extractor**.

The goal is to keep development history useful and releases identifiable
without assigning a new version number to every small change.

## 1. Commits vs. Releases

Commits and release versions serve different purposes.

-   **Commit:** Records a meaningful change in the development history.
-   **Version tag:** Marks a specific commit as a release milestone.
-   **GitHub Release:** Publishes release notes and, when applicable,
    downloadable assets for a tagged version.

A project may have many commits between two releases. Do not increment
the project version for every commit.

## 2. When to Commit

Create a commit after completing a meaningful, logically grouped change.

Examples:

-   Fixing an extraction or export bug
-   Adding a feature
-   Improving an existing feature
-   Refactoring a component or pipeline
-   Adding or updating tests
-   Updating documentation or build configuration

Use clear commit messages. Prefer the Conventional Commits format:

``` text
type(scope): short description
```

Common types:

  -----------------------------------------------------------------------
  Type                                Purpose
  ----------------------------------- -----------------------------------
  `feat`                              Add functionality

  `fix`                               Fix a bug

  `refactor`                          Change code structure without
                                      intentionally changing behavior

  `test`                              Add or update tests

  `docs`                              Documentation changes

  `chore`                             Maintenance tasks

  `perf`                              Performance improvements

  `build`                             Build system or dependency changes

  `ci`                                CI configuration changes

  `style`                             Formatting-only changes
  -----------------------------------------------------------------------

Examples:

``` text
feat(avatar): add accessory grouping
fix(export): preserve accessory hierarchy
refactor(extractor): simplify texture handling
test(backend): cover missing texture cases
docs: update installation instructions
```

Commits are development checkpoints, not public releases.

## 3. Version Format

Avarixen uses Semantic Versioning:

``` text
MAJOR.MINOR.PATCH
```

  -----------------------------------------------------------------------
  Component               Increment when...       Example
  ----------------------- ----------------------- -----------------------
  `MAJOR`                 An incompatible or      `1.9.0` → `2.0.0`
                          breaking change is
                          introduced

  `MINOR`                 New backward-compatible `1.2.0` → `1.3.0`
                          functionality is added

  `PATCH`                 Backward-compatible bug `1.2.0` → `1.2.1`
                          fixes are released
  -----------------------------------------------------------------------

Version components are numeric and are not limited to one digit. For
example, `1.10.0` is valid and is newer than `1.9.0`.

Do not increment a version just because a commit was created. Group
related changes into a release and choose the increment based on the
changes included.

## 4. Pre-release Versions

Use pre-release identifiers when a build is available for testing but is
not yet considered stable.

Common stages:

  -----------------------------------------------------------------------
  Identifier                          Use
  ----------------------------------- -----------------------------------
  `alpha`                             Early or experimental testing;
                                      functionality may be incomplete

  `beta`                              Main planned functionality is
                                      present and broader testing is
                                      underway

  `rc`                                Release candidate; intended to be
                                      feature-complete and undergoing
                                      final verification

  No suffix                           Stable release
  -----------------------------------------------------------------------

Example progression:

``` text
1.3.0-alpha.1
1.3.0-alpha.2
1.3.0-beta.1
1.3.0-beta.2
1.3.0-rc.1
1.3.0
```

The number after the pre-release identifier counts iterations of that
stage. It is not a commit number.

Not every release needs to go through alpha, beta, and RC. Use only the
stages that are useful.

## 5. When to Create a Version Tag

Create a version tag when a release milestone is ready, not after every
commit.

Before tagging, check that:

-   The intended release changes are complete.
-   Important application workflows have been tested.
-   No known release-blocking issue remains.
-   The version increment matches the changes.
-   Version metadata and release notes are updated where applicable.
-   The tag will point to the exact commit intended for release.

A release can contain a few commits or many commits. There is no
required number of commits per release.

### Suggested release checks

Adapt these checks to the scope of the release:

-   [ ] Application starts successfully.
-   [ ] Avatar extraction works for supported inputs.
-   [ ] Relevant export formats work.
-   [ ] Accessory grouping and hierarchy behave as expected.
-   [ ] Frontend and backend communicate correctly.
-   [ ] Authentication and privileged operations behave as expected.
-   [ ] Documentation and version metadata are accurate.
-   [ ] No release-blocking bugs are known.

A stable release means the project has passed its intended release
checks; it does not mean the software is guaranteed to be bug-free.

## 6. Creating and Pushing Tags

Use annotated tags for release versions.

Create a tag for the current commit:

``` bash
git tag -a v1.3.0 -m "Avarixen Avatar Extractor v1.3.0"
```

Create a tag for a specific existing commit:

``` bash
git tag -a v1.2.1 <commit-hash> -m "Avarixen Avatar Extractor v1.2.1"
```

List tags:

``` bash
git tag --list --sort=-version:refname
```

Inspect a tag:

``` bash
git show v1.3.0
```

Push one tag:

``` bash
git push origin v1.3.0
```

Push all local tags:

``` bash
git push origin --tags
```

Only push tags that are intended to be shared with the remote
repository.

## 7. Recovering a Tagged Version

To inspect an older version without changing the current working
directory, use a separate Git worktree:

``` bash
git worktree add ../Avarixen-v1.2.1 v1.2.1
```

Replace the example tag with the version to inspect. This keeps the
existing working directory separate from the historical snapshot.

## 8. Release Tag Rules

-   Do not move or reuse an existing release tag.
-   Do not silently replace a published release with different code
    under the same tag.
-   If a released version needs a follow-up fix, create a new version
    tag.
-   Keep the tag, project version metadata, and GitHub Release version
    consistent when they refer to the same release.
-   Do not call a version stable solely because its version string or
    commit message says so; verify the release.

Example:

``` text
v1.2.0          Previous stable release
v1.2.1          Compatible bug-fix release
v1.3.0-beta.1   Testing build for the next feature release
v1.3.0-rc.1     Release candidate
v1.3.0          Stable feature release
```

## 9. Everyday Workflow

During normal development:

``` text
Implement a meaningful change
        ↓
Test the change
        ↓
Create a commit
        ↓
Continue development
```

When preparing a release:

``` text
Review accumulated changes
        ↓
Run relevant release checks
        ↓
Choose the next version
        ↓
Update version metadata and release notes
        ↓
Create an annotated Git tag
        ↓
Push the tag
        ↓
Publish the GitHub Release, if applicable
```

## Core Rule

**Commit when meaningful work is completed. Create a version tag when a
release milestone is ready.**

Commits document development progress. Version tags identify releases.
