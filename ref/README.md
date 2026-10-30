# Reference photos (NOAA Shoreline Assessment Job Aid, 2014)

Field reference images shown behind the **"What does this look like?"** button on the SCAT tile
screens (oil extent and distribution, thickness, oil character, subsurface oiling, shoreline type,
treatment methods). One photo per tile where the job aid has one, plus the two percent-cover charts.

- `img/` — 58 JPEGs resized from the job aid's figures (photos 640 px wide, charts 1280 px).
- `index.json` — the pack: version, credit, and per image its label, NOAA caption, NOAA code and the
  hallway screens it illustrates (`targets`). Built by `scripts/build-ref-index.js`.
- `source/job_aid_image_index.csv` — the image index as extracted from the PDF (claude.ai chat,
  2026-10-30): file, category, label, legacy code, caption, source page, credit, licence status.
- `sizes.csv` — output of the resize step (file, width, height, bytes).

## Credit and permission

Source: NOAA Office of Response and Restoration, *Shoreline Assessment Job Aid*, September 2014.
Photos in the job aid were contributed by M.O. Hayes and J. Michel, Research Planning Inc. (RPI).
The percent-cover charts are from Owens and Sergy (1994), Environment Canada, as reproduced by NOAA.

The credit line in `index.json` is shown on the phone every time the sheet opens. Permission from RPI
to reproduce the photos in this app was requested and had **not** been confirmed when the pack was
added (2026-10-30; Jack Scott accepted the risk for the test copy). If permission is refused, delete
`img/*` except the charts, rebuild the index, and the button disappears from screens with no images.

## Rebuilding

1. Put the extracted PNGs in a folder and resize them (the PowerShell step used
   `System.Drawing`; any resizer that writes `<name>.jpg` and a `sizes.csv` of
   `file,width,height,bytes` will do).
2. `node scripts/build-ref-index.js`
3. Bump `REF_VERSION` in `sw.js` so phones fetch the new pack.

Inland gaps: the job aid is marine (sand beaches, riprap, mangroves). Cutbanks, cobble bars, vegetated
banks and ice have no photos yet. Survey photos carry their zone's thickness and character codes, so
good field photos can be promoted into this pack per code later.
