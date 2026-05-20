// GET /api/project?slug=baya-vista
// Serves full project data from data/projects.json (no Sheets dependency)
// Normalizes old-schema projects to the new template shape.

const path = require('path');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing ?slug= parameter.' });

  try {
    const projects = require(path.join(__dirname, '../data/projects.json'));
    const raw = projects.find(p => p.slug === slug);
    if (!raw) return res.status(404).json({ error: 'Project not found.' });

    return res.status(200).json(normalize(raw));

  } catch (err) {
    console.error('[/api/project]', err.message);
    return res.status(500).json({ error: 'Failed to load project.' });
  }
};

// ── Schema normalizer ───────────────────────────────────────────────────────
// Converts both old and new project entries to the unified template shape.

function normalize(p) {
  // Old schema had a flat brochures[] with a "Price List" item mixed in.
  // New schema separates priceList, brochures, factSheets, presentations, floorPlans.
  const allBrochures = p.brochures || [];
  const priceBrochure = allBrochures.find(b =>
    b.title.toLowerCase().includes('price')
  );
  const otherBrochures = allBrochures.filter(b =>
    !b.title.toLowerCase().includes('price')
  );

  return {
    // Identity
    slug:          p.slug,
    name:          p.name,
    isNew:         p.isNew          || false,
    startingPrice: p.startingPrice  || null,
    thumbnail:     p.thumbnail      || null,
    hero:          p.hero           || null,
    projectLogo:   p.projectLogo    || null,
    heroLogoStyle: p.heroLogoStyle  || null,

    // Address section
    address: p.address || null,

    // Details section
    developer:          p.developer          || null,
    architecture:       p.architecture       || null,
    interiorDesign:     p.interiorDesign      || null,
    completionDate:     p.completionDate      || null,
    theBuilding:        p.theBuilding         || p.buildingDescription || null,
    depositStructure:   normalizeLines(p.depositStructure),
    stylishAmenities:   p.stylishAmenities    || null,
    parkingSpaces:      normalizeLines(p.parkingSpaces),
    rentalRestrictions: normalizeLines(p.rentalRestrictions),
    hoa:                p.hoa                 || null,
    contact:            p.contact             || null,

    // Document sections
    priceList: p.priceList || (priceBrochure
      ? { text: null, driveFileId: priceBrochure.driveFileId || '' }
      : null),
    priceRange:    p.priceRange      || null,
    brochures:     p.brochures_v2    || otherBrochures,
    factSheets:    p.factSheets      || [],
    presentations: p.presentations   || [],
    floorPlans:    p.floorPlans      || [],

    // Gallery
    renderings: p.renderings || [],
  };
}

// Accepts a string (newline-separated), array, or null → always returns array or null
function normalizeLines(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.filter(Boolean);
  const lines = value.split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length ? lines : null;
}
