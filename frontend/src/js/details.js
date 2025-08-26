// Artwork Details page script
(function(){
  function getData() {
    try {
      const raw = localStorage.getItem('artlens:lastArtwork');
      if (raw) return JSON.parse(raw);
    } catch {}
    // Fallback sample to make page testable directly
    return {
      title: 'The Starry Night',
      artist: 'Vincent van Gogh',
      year: '1889',
      museum: 'Museum of Modern Art',
      location: 'New York City, USA',
      description: 'The Starry Night is an oil-on-canvas painting created in June 1889. It depicts the view from the east-facing window of van Gogh\'s asylum room at Saint-Rémy-de-Provence, just before sunrise, with the addition of an imaginary village.',
    };
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? '—';
  }

  const data = getData();
  setText('artTitle', data.title || 'Artwork');
  setText('artistVal', data.artist || '—');
  setText('yearVal', data.year || '—');
  setText('museumVal', data.museum || '—');
  setText('locationVal', data.location || '—');
  setText('descVal', data.description || '—');

  // Back button
  const back = document.getElementById('goBack');
  if (back) back.addEventListener('click', () => {
    if (history.length > 1) history.back();
    else window.location.href = 'index.html';
  });
})();
