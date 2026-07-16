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

**Title**:
A human-readable name for a Publication, either extracted from the `<title>` tag in the entry HTML or supplied explicitly via `--title` at publish time. Titles are shown in `artifacts list`.
_Avoid_: name, label (use Title)

**Living Doc**:
A collaborative Markdown document an agent publishes so a human can edit it and comment on it, and the agent can pull that feedback back to continue the work. Unlike a Publication, a Living Doc is mutable and two-party: it is edited continuously on the human side and revised by the agent through Suggestions. A Living Doc is a distinct concept from a Publication and is never a read-only static Artifact. Stored Markdown may include YAML front matter; publish, Doc Asset rewrite, Versions, and `doc pull` keep that front matter intact (the View Link may render the body only so fences are not shown as content).
_Avoid_: Document, page, review, draft, artifact, publication

**Reviewer**:
The pseudonymous human who edits and comments on a Living Doc by holding its Review Link. A Reviewer is not authenticated and is not a Publisher; they may supply a display name, otherwise their contributions are attributed to "a Reviewer".
_Avoid_: User, editor, collaborator, guest, commenter

**View Link**:
The read-only URL for a Living Doc that renders its current Markdown. Holding a View Link never grants the ability to edit or comment.
_Avoid_: Public link, share link, read link

**Review Link**:
The capability URL for a Living Doc that grants editing and commenting. Anyone holding the Review Link is a Reviewer; it is a separate, more privileged URL than the View Link and is handed only to those meant to give feedback.
_Avoid_: Edit link, invite, magic link, token

**Version**:
An immutable snapshot of a Living Doc's Markdown captured at the moment an agent pulls feedback. Versions are numbered in order and give both the agent and the Reviewer a stable reference point ("as of Version 3") even though editing is otherwise continuous.
_Avoid_: Revision, commit, snapshot (use Version), Revision Window (that is a Publication concept)

**Comment**:
A note a Reviewer attaches to a specific span of a Living Doc's Markdown. A Comment carries the quoted span it is anchored to so the agent knows exactly what it refers to. Comments stay open until resolved.
_Avoid_: Annotation, note, review comment

**Suggestion**:
A change to a specific span of a Living Doc that an agent proposes in response to feedback. A Suggestion is never applied automatically; the Reviewer accepts or rejects it. Suggestions are how the agent edits a Living Doc, mirroring the Reviewer's direct edits.
_Avoid_: Edit, patch, diff, tracked change, proposal

**Doc Asset**:
A binary file hosted with a Living Doc and referenced from its Markdown (for example an image). Doc Assets belong to the Living Doc; they are not an Artifact and are not served as a Publication.
_Avoid_: Artifact, attachment, media, Publication asset, Artifact Path
