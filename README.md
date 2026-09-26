# RadioIllustrator

A web app for drawing colored overlays on a DICOM series, for example the spinal canal on a
sagittal or axial spine MRI, and exporting the annotated series for a Radiopaedia case. It runs
in the browser. DICOM files are read locally and are not uploaded anywhere.

Live version: <https://gmadevs.github.io/RadioIllustrator/>

## Running it locally

```bash
npm install
npm run dev
```

Then open the address Vite prints (usually http://localhost:5173). `npm run build` writes a
static build to `dist/`.

## Workflow

1. Drop a folder or DICOM files onto the window, or use **Open files** or **Open folder**. If
   the files contain more than one series, pick one from the menu in the toolbar.
2. The right panel starts with one structure, "Spinal canal". **+ New** adds more. Each
   structure has a name, color, opacity, an outline switch and an interpolation switch.
3. Draw the structure on a few slices. A slice you draw on becomes a key slice. The slices
   between two key slices are filled by interpolation. Editing an interpolated slice turns it
   into a key slice.
4. **Export…** writes the series with the overlay burned into the pixels.

The strip above the slice slider shows, for the active structure, the key slices (full-height
marks), the interpolated slices (short marks) and empty key slices (outlined marks).

### Tools

| Tool | Key | Use |
|---|---|---|
| Brush | B | paints; hold Alt to erase |
| Eraser | E | erases |
| Polygon | P | click the vertices; close with Enter, a double click, or a click on the first point; hold Alt to subtract |
| Pan | H | drags the image (Space or the middle mouse button also pan) |

Other shortcuts:

| Input | Action |
|---|---|
| Mouse wheel, arrow keys, Page Up/Down | change slice |
| Ctrl or ⌘ + wheel | zoom |
| Right-button drag | window level and width |
| `[` `]` | brush size |
| `C`, `Shift+C` | copy the mask from the previous or next slice |
| `O` | show or hide the overlay |
| `F` | fit the image to the view |
| ⌘Z, ⇧⌘Z | undo, redo |

**Clear slice** makes the current slice an empty key slice. Towards it the structure shrinks
evenly to nothing. **Remove key slice** returns the slice to its interpolated shape.

For CT series the **Window** menu has soft tissue (40/400), bone (400/1800) and canal/cord
(40/250) presets, besides the window stored in the DICOM and an automatic one.

### Interpolation

Each key slice is turned into a signed distance map: negative inside the mask, positive
outside, in pixels. For a slice between two keys, both maps are shifted onto the interpolated
centroid and then averaged; the mask is the negative part. This works the same for brush and
polygon masks, and follows a structure that moves between slices. A structure that splits in
two between two key slices is not handled well. Add a key slice in between.

## Export

- **PNG or JPEG**: numbered images (`001.png`, `002.png`…) for a manual upload to Radiopaedia.
- **DICOM Secondary Capture** (RGB, explicit VR little endian): a new series in the same study.
  It keeps the StudyInstanceUID, gets a new SeriesInstanceUID and SeriesNumber 9001, and copies
  the position, orientation and InstanceNumber of each source slice, so Radiouploader uploads
  it next to the original series.
- **Also the same series without overlay**: writes the same slices without color
  (SeriesNumber 9002), with the same window and scale, to give two aligned stacks for a
  before/after comparison.

The export uses the current window. At a scale of 2× or 3× the image is enlarged and
PixelSpacing is divided by the same factor. The default scale is 2× for series narrower than
400 pixels and 1× otherwise. The result is a zip file. In Chrome and Edge, **Save to folder…**
writes the files into a folder you choose.

The zip has an `annotated/` folder and, with the option above, an `original/` folder, each with
`png/` or `jpeg/` and `dicom/` subfolders.

**The exported DICOM files keep the patient data of the source series.** Anonymize them before
sharing them; Radiouploader does this when it uploads. PNG and JPEG files carry no metadata.

## Saving your work

Annotations are saved automatically in the browser (localStorage), per series, and come back
when you open the same series again. Browser storage is per site: annotations made on
`localhost` do not appear on the GitHub Pages version.

**Save annotations** downloads a `.radioillustrator.json` file with the key slices, run-length
encoded. **Load annotations**, or dropping the file onto the window, opens it on the same
series. Interpolated slices are rebuilt on load.

## Limitations

- Only uncompressed transfer syntaxes are read (implicit and explicit VR little endian, and
  deflated). A JPEG, JPEG 2000 or RLE series is rejected with a message; export it
  uncompressed from the PACS.
- Pixels are treated as square. A series with different row and column spacing looks slightly
  stretched.
- Enhanced multi-frame files are split into their frames in file order. Per-frame functional
  groups are not read.

## Code layout

| File | Contents |
|---|---|
| `src/dicom/load.ts` | reading files, grouping by series, sorting along the slice normal |
| `src/dicom/write.ts` | Secondary Capture writer |
| `src/mask/raster.ts` | brush, polygon fill, run-length encoding |
| `src/mask/interpolate.ts` | distance transform and interpolation |
| `src/model.ts` | structures, key slices, undo, project files |
| `src/render.ts` | image and overlay compositing, shared by the viewer and the export |
| `src/export.ts` | PNG, JPEG and DICOM output, zip, saving to a folder |
| `src/main.ts` | user interface |

`npm test` runs `tests/core.test.ts`. If `~/radiouploader-sample` exists, the tests also load
the DICOM files in it.

Every push to `main` runs the tests, builds the site and deploys it to GitHub Pages
(`.github/workflows/pages.yml`).

## Writing documentation

Documentation follows plain technical prose: headings say what a section covers, one point per
sentence, few dashes, no staged contrasts, bold only for interface labels and warnings. Check a
page you change with `npm run prose`.
