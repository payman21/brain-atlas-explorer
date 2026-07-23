# Brain Atlas Explorer

**Live app: https://brain-atlas-explorer.pages.dev/**

Open a parcellation in the browser and explore it: search regions by name,
select several at once, recolour them, isolate them from the rest, and click to
identify what is under the cursor.

Everything runs client-side. **No file you open is uploaded anywhere** — files
are decoded in the browser and never leave the machine.

## Two paths

The app branches on what a parcellation actually *is*, because volumes and
grayordinates want different views:

| | Volumetric | Surface |
|---|---|---|
| Input | labelled NIfTI + label table | CIFTI `.dlabel.nii` or GIFTI `.label.gii` |
| View | three orthogonal slices in a row above a 3D render, or a single slice, or the render alone | four fixed panels: left/right × lateral/medial |
| Over | a bundled MNI152 template | nothing — just the cortical surface |
| Controls | layout, atlas opacity, template, crosshair, label offset | surface style, background, reset angles |
| Export | PNG of the slice view | PNG of the whole panel grid |

Both share the region list, so search, multi-select, recolour and isolate work
the same either way.

**CIFTI files are read as cortex only.** A `.dlabel.nii` mixes cortical surface
vertices with subcortical voxels; the subcortical structures belong to the
volumetric path, so they are dropped from the surface view with a note saying
how many. Load the matching volumetric atlas to explore those.

## Running it

```bash
npm install
npm run dev
```

Then open the printed URL and press **Load AAL demo**, or drop your own files
onto the window.

## What it does today

- **Volumetric:** a labelled NIfTI over a bundled MNI152 template, in
  multiplanar, single-slice, or 3D-render layouts. Click a region in the list to
  centre the crosshair on it.
- **Surface:** CIFTI or GIFTI cortical labels on fs_LR 32k surfaces, shown as
  the conventional four-panel figure, inflated or midthickness, on a dark or
  light background. A shared **Zoom** slider (and **Reset size**) keeps the four
  panels the same size — scrolling any one of them zooms all four together.
- Reads label tables from seven sidecar formats (below), plus the tables
  embedded inside CIFTI and GIFTI files.
- Region list with substring search across name, abbreviation and label value.
- Multi-select, per-region colour picker, and an **isolate** mode that hides
  everything except the selection.
- Click-to-identify: region name, label value, and voxel or vertex count.

## Region values (heatmaps)

Beyond viewing the parcellation, you can drape a per-region scalar over it — an
activation map, a hierarchy level, a gradient, any one-number-per-region
measure — and render it as a heatmap. Load a parcellation first, then either use
**Load region values…** in the sidebar or drop the value file onto the window.

The file is matched to the loaded regions three ways, chosen by inspection:

| File shape | Example | Matched by |
|---|---|---|
| name, value | `Precentral_L,2.31` | region name (case/punctuation-insensitive) |
| index, value | `1,2.31` | label value |
| one value per line | `2.31` | row order, ascending label value (positional — warns) |

A header row is optional; common column names (`region`/`name`,
`value`/`activation`/`tstat`/…) are recognised. Unmatched rows and regions left
without a value are both reported; valueless regions render in neutral grey.

Seven colormaps are available — sequential (Viridis, Magma, Inferno, Plasma,
Cividis) and diverging (Red–Blue, Cool–Warm, Red–Yellow–Blue) — and **Reverse**
flips any of them end for end, so Red–Blue becomes Blue–Red without a separate
entry. When the data span zero, a diverging map centred on zero is chosen
automatically, so red/blue reads as sign rather than above/below the mean;
otherwise a sequential map is used. The colourbar sits under the view — labelled
with the value range and midpoint — and is drawn into the exported PNG too, so a
heatmap figure is self-contained. The range is editable (with **Auto** to reset).

## Exporting images

**Save PNG** in the toolbar renders at 2×, 4× or 8× the on-screen size. The
drawing buffer is enlarged and the scene re-rendered, so this is genuine extra
resolution, not an upscale of what you see. In the surface path all four panels
are composed into one sheet; in the volumetric path you get the slice view.

At 4× a maximised window produces roughly 4600 × 3450 px, which is about 15 × 11
inches at 300 dpi — comfortably past most journals' raster minimum.

It is still raster. Vector output (SVG/PDF) is not possible from WebGL and would
need a server-side renderer; see *Not built yet*. For a figure, set the
background to **Light** first — the surface panels then render on white.

## Supported label formats

| Format | Extension | Colours | Notes |
|---|---|---|---|
| BIDS `dseg.tsv` | `.tsv` | `color` hex or `r`/`g`/`b` | Canonical internal form |
| CSV label table | `.csv` | same | Same column rules |
| FreeSurfer colour LUT | `.txt`, `.lut` | yes | `value name R G B A` |
| ITK-SNAP label description | `.txt`, `.label` | yes | Quoted label, 8 columns |
| FSL atlas XML | `.xml` | no | `index` is 0-based — see below |
| JSON colour table / map / records | `.json` | depends | NiiVue `{R,G,B,labels}`, `{"1":"name"}`, or `[{index,name,color}]` |
| Connectome Workbench label list | `.txt` | yes | Name line, then `key R G B A` — Schaefer, Glasser, Tian |
| Plain name list | `.txt` | no | Names only, one per line; values assumed 1…N, always warns |

Self-describing formats need no sidecar at all:

| Format | Extension | Carries |
|---|---|---|
| CIFTI-2 dense label | `.dlabel.nii` | label table, cortical vertices, subcortical voxels (dropped) |
| GIFTI label | `.label.gii` | label table and one hemisphere's vertices |

Column names are matched liberally (`index`/`value`/`id`, `name`/`region`/`label`
and so on). Formats without colours get a deterministic golden-angle palette, so
adjacent label values never receive similar colours.

Dropping a volume with no label table is fine — values are read from the image
and named `Label N`.

### The label-offset problem

The most common ingestion failure is a table whose values are off by one from
the image: FSL's atlas XML stores a **0-based `index`** while the corresponding
maxprob volume uses `index + 1`, and hand-made tables vary on whether background
counts as a row.

Rather than making you know this, the app compares the table against the label
values actually present in the volume, tries offsets of −1, 0 and +1, and picks
whichever explains the data best. It says so when it shifts anything, and the
**Label offset** control in the toolbar overrides it. Values in the volume with
no matching row, and rows matching no voxel, are both reported and the latter are
greyed out in the list.

## Surface geometry

CIFTI and GIFTI label files contain **no vertex coordinates** — only label
values indexed by vertex. Geometry has to come from somewhere else, so the app
bundles fs_LR 32k surfaces in `public/surfaces/` and matches them to labels by
vertex count (32492). Drop your own `.surf.gii` alongside the labels to override
them, which is also how you view any other mesh resolution.

The bundled meshes are the openly redistributable **fs_LR 32k group-average**
surfaces from [TemplateFlow](https://www.templateflow.org) (`tpl-fsLR`,
`den-32k`, inflated and midthickness). They are a shared template, not any
individual's brain, so they are safe to publish and appropriate for figures.

## Architecture

```
src/
  labels/       format adapters → one canonical LabelTable
    parse.ts        dispatcher, dedupe, colour fill, value reconciliation
    grayordinates.ts  shared surface/volume label types
    formats/        delimited · plainText · workbench · fslXml · json
                    gifti · cifti · binaryXml (base64 + inflate helpers)
  scalars/      per-region values → heatmap
    values.ts       parse value files, match to regions
    heatmap.ts      domain + colormap → per-region colours
  viewer/
    atlasViewer.ts  volumetric path: NiiVue slices, label LUT, centroids
    surfaceView.ts  surface path: one NiiVue instance per panel
    colormaps.ts    continuous colormaps (sequential + diverging)
    colors.ts       categorical palette generation and hex conversion
  ui/           dropzone, region list, message area
  state.ts      store + subscription
  main.ts       wiring, the two ingestion paths, heatmap derivation
```

Heatmaps reuse the paint path rather than adding one: when values are loaded,
`main.ts` swaps each region's categorical colour for its scalar-mapped colour
before painting, so search, isolate, selection and export all keep working
unchanged. Regions carry the same label values throughout — only their colours
differ.

Rendering is [NiiVue](https://github.com/niivue/niivue) in both paths, and both
use more than one instance for the same reason: a NiiVue instance has a single
camera and layout. The volumetric path runs two — a slice pane above, a 3D
render pane below — because NiiVue's own multiplanar layouts never put the
render beneath the slices. The surface path runs one per panel, for four angles.
In every pane the template is volume 0 in greyscale and the parcellation is
volume 1, kept in step by mirroring loads, colour changes and crosshair moves
across panes.

Both paint through the same mechanism: a label LUT rebuilt whenever selection or
colour changes, with hidden regions set to zero alpha. Isolation therefore costs
one LUT upload rather than a re-render.

NiiVue is not able to read these files itself — its CIFTI code path treats the
data as scalar overlays on an already-loaded mesh, skips every non-cortex brain
model, and ignores the label table — so `cifti.ts` parses the NIfTI-2 container,
the XML extension, the brain models and the label table directly.

Voxel counts and a representative voxel per region are computed when the volume
loads, which is what makes list jumps and size readouts instant. The jump target
is deliberately *not* the centre of mass: most atlas regions are bilateral, so
their centroid sits near the midline inside a different structure. The app snaps
to the nearest voxel actually carrying the label, which is guaranteed to be
inside the region.

## Testing with real atlases

If FSL is installed, `$FSLDIR/data/atlases/` is the richest source on hand —
Harvard-Oxford, Juelich, JHU, Cerebellum, Talairach, each with a `.nii.gz` and a
sibling `.xml`. Harvard-Oxford is the best regression test because it exercises
the 0-based index path:

```
$FSLDIR/data/atlases/HarvardOxford/HarvardOxford-cort-maxprob-thr25-2mm.nii.gz
$FSLDIR/data/atlases/HarvardOxford-Cortical.xml
```

Loading that pair should report 48 regions, auto-shift the offset to +1, and
name no unmatched values.

## Not built yet

These are known gaps, not oversights:

- **Volume → surface projection.** A volumetric atlas stays volumetric. Mapping
  one onto a surface needs `vol_to_surf`-style resampling that has no browser
  equivalent yet.
- **Subcortical structures from CIFTI.** Parsed and then discarded. Rendering
  them means a hybrid scene mixing a voxel volume with surfaces, which is a
  different design question from either current path.
- **Vector export.** PNG at up to 8× is available, but SVG/PDF is not: WebGL
  renders pixels, so real vector output needs a server-side nilearn/matplotlib
  path. That is the one remaining reason to reach for `surfplot` or
  Connectome Workbench instead.
- **Figure furniture.** No colourbar, region labels, or titles in the exported
  image — you get the brains, and assemble the rest in Illustrator or Inkscape.
- **siibra enrichment.** Feeding the uploaded parcellation through
  `siibra.volumes.from_nifti` → `parcellationmap.from_volume` would add "what
  does this region overlap in Julich-Brain" with correlation and IoU, plus gene
  expression and connectivity queries. It requires a Python backend and only
  works for volumes prealigned to MNI152/Colin27/BigBrain/fsaverage, so it has to
  degrade gracefully rather than sit in the load path.
- **Alignment is assumed.** The bundled template is MNI152. A volume in another
  space will still display, but it will not line up, and nothing currently warns
  about it.
