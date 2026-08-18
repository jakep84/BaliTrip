module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // This is a browser key, so it is expected to be visible to the browser.
  // Protect it in Google Cloud with Website (HTTP referrer) restrictions
  // and restrict it to Maps JavaScript API + Places API (New).
  const key =
    process.env.GOOGLE_MAPS_BROWSER_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    '';

  if (!key) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({
      error: 'Google Maps is not configured.',
      requiredEnv: 'GOOGLE_MAPS_BROWSER_KEY'
    });
  }

  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  return res.status(200).json({ key });
};
