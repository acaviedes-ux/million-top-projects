// GET /api/projects
// Serves the project list directly from data/projects.json (no Sheets dependency)

const path = require('path');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

  try {
    const projects = require(path.join(__dirname, '../data/projects.json'));

    const list = projects.map(p => ({
      name:          p.name,
      slug:          p.slug,
      section:       p.section        || null,
      startingPrice: p.startingPrice  || null,
      thumbnail:     p.thumbnail      || null,
      isNew:         p.isNew          || false,
      filterCounty:  p.filterCounty   || null,
      filterLocation:p.filterLocation || null,
      filterStatus:  p.filterStatus   || null,
      filterYear:    p.filterYear     || null,
    }));

    return res.status(200).json(list);

  } catch (err) {
    console.error('[/api/projects]', err.message);
    return res.status(500).json({ error: 'Failed to load projects.' });
  }
};
