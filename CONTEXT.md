# Artifacts

Artifacts is a TheFocus.AI publishing context for agent-generated static web output that can be shared through unlisted URLs.

## Language

**Artifact**:
A static web bundle produced by an agent. An Artifact is published from one local HTML file or one local directory containing a root entry page and supporting assets; obvious secret, dependency, and cache paths are excluded from publishing by default.
_Avoid_: File, page, site

**Entry Page**:
The HTML document served when a Publication URL is opened. For a directory Artifact, the Entry Page is the root `index.html` unless a Publisher explicitly chooses a different HTML file.
_Avoid_: Homepage, landing page, default file

**Artifact Path**:
A path inside a directory Artifact that is served under its Publication URL. Artifact Paths can include nested files and directories, but are never listed publicly.
_Avoid_: Route, URL path, directory listing

**Publication**:
A hosted Artifact available at a short opaque unlisted URL. A Publication is intended to keep a stable client-facing URL while showing the latest synced version of its Artifact.
_Avoid_: Deployment, upload, share link, channel, token

**Unlisted**:
Accessible to anyone who has the URL, but absent from public indexes, browsing interfaces, and search engine indexing. The service may have a minimal TheFocus.AI landing page, but it does not expose a public Publication listing.
_Avoid_: Private, authenticated, secret

**Publisher**:
A verified TheFocus.AI team member who can create and update Publications.
_Avoid_: User, admin, owner

**Publisher Token**:
A local credential that lets an agent or command-line tool publish on behalf of a Publisher after one-time authentication.
_Avoid_: Password, API key, viewer token

**Revision Window**:
A short rolling period after a Publication is created or updated during which publishing again from the same local source updates the same client-facing URL by default. During an update, the hosted Artifact mirrors the Local Source, including removing files that no longer exist locally. After the Revision Window, publishing from that source creates a new Publication unless the Publisher explicitly requests an update.
_Avoid_: Live site, channel, version history

**Removal**:
The act of disabling a Publication so its client-facing URL no longer serves the Artifact.
_Avoid_: Deletion, unpublish, archive

**Local Source**:
The canonical local filesystem path that a Publisher publishes from. The same Local Source can update the same Publication during its Revision Window.
_Avoid_: Project, repository, folder mapping
