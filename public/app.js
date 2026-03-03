const EDITABLE_FIELDS = ["title", "releaseYear", "rated", "description", "genre", "language", "country", "poster", "trailerLink"];

const state = {
  movies: [],
  filteredMovies: [],
  featuredMovieId: null,
  editingMovieId: null,
  activeTrailerToken: null
};

const ui = {
  heroSection: document.getElementById("heroSection"),
  heroBackdrop: document.getElementById("heroBackdrop"),
  heroTitle: document.getElementById("heroTitle"),
  heroMeta: document.getElementById("heroMeta"),
  heroDescription: document.getElementById("heroDescription"),
  heroPlayButton: document.getElementById("heroPlayButton"),
  heroTrailerButton: document.getElementById("heroTrailerButton"),
  heroEditButton: document.getElementById("heroEditButton"),
  searchInput: document.getElementById("searchInput"),
  rescanButton: document.getElementById("rescanButton"),
  statusText: document.getElementById("statusText"),
  movieGrid: document.getElementById("movieGrid"),
  movieCardTemplate: document.getElementById("movieCardTemplate"),
  trailerModal: document.getElementById("trailerModal"),
  closeTrailerModal: document.getElementById("closeTrailerModal"),
  trailerModalTitle: document.getElementById("trailerModalTitle"),
  trailerFrame: document.getElementById("trailerFrame"),
  trailerHint: document.getElementById("trailerHint"),
  editModal: document.getElementById("editModal"),
  closeEditModal: document.getElementById("closeEditModal"),
  editModalTitle: document.getElementById("editModalTitle"),
  editForm: document.getElementById("editForm"),
  cancelEditButton: document.getElementById("cancelEditButton"),
  saveEditButton: document.getElementById("saveEditButton")
};

function formatMovieMeta(movie) {
  return [
    `Year: ${movie.releaseYear || "Unknown"}`,
    `Rated: ${movie.rated || "N/A"}`,
    `Genre: ${movie.genre || "N/A"}`,
    `Language: ${movie.language || "N/A"}`,
    `Country: ${movie.country || "N/A"}`
  ].join(" | ");
}

function normalizeSearch(value) {
  return String(value || "").toLowerCase().trim();
}

function getFeaturedMovie() {
  return state.movies.find((movie) => movie.id === state.featuredMovieId) || state.movies[0] || null;
}

function getMovieById(movieId) {
  return state.movies.find((movie) => movie.id === movieId) || null;
}

function isDefaultOrMissingValue(field, value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return true;
  }

  if (field === "description" && normalized === "No description found.") {
    return true;
  }

  if ((field === "rated" || field === "genre" || field === "language" || field === "country") && normalized === "N/A") {
    return true;
  }

  return false;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

function setStatus(text) {
  ui.statusText.textContent = text;
}

function setTrailerHint(text, isError = false) {
  if (!text) {
    ui.trailerHint.textContent = "";
    ui.trailerHint.classList.add("hidden");
    ui.trailerHint.classList.remove("is-error");
    return;
  }

  ui.trailerHint.textContent = text;
  ui.trailerHint.classList.remove("hidden");
  ui.trailerHint.classList.toggle("is-error", Boolean(isError));
}

function openModal(modalElement) {
  modalElement.classList.remove("hidden");
  modalElement.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeModal(modalElement) {
  modalElement.classList.add("hidden");
  modalElement.setAttribute("aria-hidden", "true");

  if (ui.trailerModal.classList.contains("hidden") && ui.editModal.classList.contains("hidden")) {
    document.body.classList.remove("modal-open");
  }
}

async function openTrailerModal(movie) {
  const trailerToken = Symbol("trailer");
  state.activeTrailerToken = trailerToken;

  ui.trailerModalTitle.textContent = `${movie.title} Trailer`;
  ui.trailerFrame.src = "about:blank";
  setTrailerHint("Finding a playable trailer...");
  openModal(ui.trailerModal);

  try {
    const payload = await fetchJson(`/api/movies/${encodeURIComponent(movie.id)}/trailer`);

    if (state.activeTrailerToken !== trailerToken || ui.trailerModal.classList.contains("hidden")) {
      return;
    }

    if (payload.embedUrl) {
      ui.trailerFrame.src = payload.embedUrl;
      setTrailerHint("");
      return;
    }

    setTrailerHint("No embeddable trailer found. Use Edit and paste a direct YouTube Trailer URL.", true);
  } catch (error) {
    if (state.activeTrailerToken !== trailerToken || ui.trailerModal.classList.contains("hidden")) {
      return;
    }

    setTrailerHint("Trailer lookup failed. Use Edit and set a direct YouTube Trailer URL.", true);
    setStatus(`Could not open trailer: ${error.message}`);
  }
}

function closeTrailerModal() {
  state.activeTrailerToken = null;
  ui.trailerFrame.src = "about:blank";
  setTrailerHint("");
  closeModal(ui.trailerModal);
}

function openEditModal(movie) {
  state.editingMovieId = movie.id;
  ui.editModalTitle.textContent = `Edit Details: ${movie.title}`;

  for (const field of EDITABLE_FIELDS) {
    const input = ui.editForm.elements.namedItem(field);
    if (!input) {
      continue;
    }

    const value = movie[field];
    input.value = isDefaultOrMissingValue(field, value) ? "" : String(value || "");
  }

  openModal(ui.editModal);
}

function closeEditModal() {
  state.editingMovieId = null;
  ui.editForm.reset();
  closeModal(ui.editModal);
}

async function playMovie(movieId) {
  await fetchJson("/api/play", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ id: movieId })
  });
}

async function saveMovieOverride(movieId, payload) {
  return fetchJson(`/api/movies/${encodeURIComponent(movieId)}/override`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

function renderFeaturedMovie() {
  const movie = getFeaturedMovie();
  if (!movie) {
    ui.heroSection.classList.add("hidden");
    return;
  }

  ui.heroSection.classList.remove("hidden");
  ui.heroTitle.textContent = movie.title || "Unknown title";
  ui.heroMeta.textContent = formatMovieMeta(movie);
  ui.heroDescription.textContent = movie.description || "No description found.";

  if (movie.poster) {
    ui.heroBackdrop.style.backgroundImage = `url("${movie.poster}")`;
  } else {
    ui.heroBackdrop.style.backgroundImage =
      "linear-gradient(120deg, rgba(229, 9, 20, 0.55), rgba(10, 10, 10, 0.96))";
  }

  ui.heroPlayButton.onclick = async () => {
    try {
      await playMovie(movie.id);
      setStatus(`Playing ${movie.title} in your default video player.`);
    } catch (error) {
      setStatus(`Could not play movie: ${error.message}`);
    }
  };

  ui.heroTrailerButton.onclick = () => {
    void openTrailerModal(movie);
  };

  if (movie.missingInfo || movie.isManuallyEdited) {
    ui.heroEditButton.classList.remove("hidden");
    ui.heroEditButton.textContent = movie.missingInfo ? "Edit Missing Info" : "Edit Details";
    ui.heroEditButton.onclick = () => openEditModal(movie);
  } else {
    ui.heroEditButton.classList.add("hidden");
  }
}

function makeMovieCard(movie, index) {
  const node = ui.movieCardTemplate.content.firstElementChild.cloneNode(true);
  node.style.animationDelay = `${Math.min(index * 30, 540)}ms`;

  const posterShell = node.querySelector(".poster-shell");
  const poster = node.querySelector(".poster");
  const fallbackTitle = node.querySelector(".fallback-title");
  const title = node.querySelector(".movie-title");
  const meta = node.querySelector(".movie-meta");
  const genre = node.querySelector(".movie-genre");
  const origin = node.querySelector(".movie-origin");
  const description = node.querySelector(".movie-description");
  const playButton = node.querySelector(".play-btn");
  const trailerButton = node.querySelector(".trailer-btn");
  const editButton = node.querySelector(".edit-btn");

  title.textContent = movie.title;
  meta.textContent = `Year of Release: ${movie.releaseYear || "Unknown"} | Rated: ${movie.rated || "N/A"}`;
  genre.textContent = `Genre: ${movie.genre || "N/A"}`;
  origin.textContent = `Language: ${movie.language || "N/A"} | Country of Origin: ${movie.country || "N/A"}`;
  description.textContent = movie.description || "No description found.";
  fallbackTitle.textContent = movie.title;

  if (movie.poster) {
    poster.src = movie.poster;
    poster.alt = `${movie.title} poster`;
  } else {
    posterShell.classList.add("no-image");
  }

  posterShell.addEventListener("click", () => {
    state.featuredMovieId = movie.id;
    renderFeaturedMovie();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  playButton.addEventListener("click", async () => {
    const originalLabel = playButton.textContent;
    playButton.disabled = true;
    playButton.textContent = "Opening...";

    try {
      await playMovie(movie.id);
      setStatus(`Playing ${movie.title} in your default video player.`);
    } catch (error) {
      setStatus(`Could not play movie: ${error.message}`);
    } finally {
      playButton.disabled = false;
      playButton.textContent = originalLabel;
    }
  });

  trailerButton.addEventListener("click", () => {
    void openTrailerModal(movie);
  });

  editButton.addEventListener("click", () => {
    openEditModal(movie);
  });

  if (movie.missingInfo) {
    editButton.textContent = "Fix";
  } else if (movie.isManuallyEdited) {
    editButton.textContent = "Edit";
  } else {
    editButton.classList.add("soft");
  }

  return node;
}

function renderMovieGrid() {
  ui.movieGrid.innerHTML = "";

  if (!state.filteredMovies.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No movies matched the current search.";
    ui.movieGrid.appendChild(empty);
    return;
  }

  const cards = state.filteredMovies.map((movie, index) => makeMovieCard(movie, index));
  ui.movieGrid.append(...cards);
}

function applySearch() {
  const query = normalizeSearch(ui.searchInput.value);
  if (!query) {
    state.filteredMovies = [...state.movies];
    renderMovieGrid();
    setStatus(`Showing ${state.filteredMovies.length} movies from your local drive.`);
    return;
  }

  state.filteredMovies = state.movies.filter((movie) => {
    const haystack = `${movie.title} ${movie.genre} ${movie.language} ${movie.country} ${movie.rated} ${movie.releaseYear}`.toLowerCase();
    return haystack.includes(query);
  });

  renderMovieGrid();
  setStatus(`Found ${state.filteredMovies.length} movie(s) matching "${query}".`);
}

async function loadMovies(options = {}) {
  const preserveSearch = options.preserveSearch === true;
  const previousSearch = preserveSearch ? ui.searchInput.value : "";
  const previousFeaturedId = options.preserveFeaturedId || null;

  setStatus("Syncing local movies and IMDb metadata...");

  const payload = await fetchJson("/api/movies");
  state.movies = payload.movies || [];

  if (previousFeaturedId && getMovieById(previousFeaturedId)) {
    state.featuredMovieId = previousFeaturedId;
  } else if (!getMovieById(state.featuredMovieId)) {
    state.featuredMovieId = state.movies[0] ? state.movies[0].id : null;
  }

  state.filteredMovies = [...state.movies];
  renderFeaturedMovie();
  renderMovieGrid();

  const timestamp = payload.lastScan ? new Date(payload.lastScan).toLocaleString() : "N/A";
  setStatus(`Loaded ${state.movies.length} movies from ${payload.sourceDir || "unknown folder"}. Last scan: ${timestamp}.`);

  if (preserveSearch && previousSearch.trim()) {
    ui.searchInput.value = previousSearch;
    applySearch();
  }
}

async function rescanMovies() {
  ui.rescanButton.disabled = true;
  ui.rescanButton.textContent = "Scanning...";

  try {
    await fetchJson("/api/rescan", {
      method: "POST"
    });

    await loadMovies({
      preserveSearch: true,
      preserveFeaturedId: state.featuredMovieId
    });
  } catch (error) {
    setStatus(`Rescan failed: ${error.message}`);
  } finally {
    ui.rescanButton.disabled = false;
    ui.rescanButton.textContent = "Rescan Drive";
  }
}

async function submitEditForm(event) {
  event.preventDefault();

  if (!state.editingMovieId) {
    return;
  }

  const movie = getMovieById(state.editingMovieId);
  if (!movie) {
    setStatus("Could not find movie for editing.");
    closeEditModal();
    return;
  }

  const formData = new FormData(ui.editForm);
  const payload = {};

  for (const field of EDITABLE_FIELDS) {
    payload[field] = formData.get(field);
  }

  ui.saveEditButton.disabled = true;
  ui.saveEditButton.textContent = "Saving...";

  try {
    await saveMovieOverride(movie.id, payload);

    await loadMovies({
      preserveSearch: true,
      preserveFeaturedId: movie.id
    });

    closeEditModal();
    setStatus(`Saved manual details for ${movie.title}.`);
  } catch (error) {
    setStatus(`Could not save changes: ${error.message}`);
  } finally {
    ui.saveEditButton.disabled = false;
    ui.saveEditButton.textContent = "Save Changes";
  }
}

function wireEvents() {
  ui.searchInput.addEventListener("input", applySearch);
  ui.rescanButton.addEventListener("click", rescanMovies);

  ui.closeTrailerModal.addEventListener("click", closeTrailerModal);
  ui.trailerModal.addEventListener("click", (event) => {
    if (event.target?.dataset?.close === "trailer") {
      closeTrailerModal();
    }
  });

  ui.closeEditModal.addEventListener("click", closeEditModal);
  ui.cancelEditButton.addEventListener("click", closeEditModal);
  ui.editModal.addEventListener("click", (event) => {
    if (event.target?.dataset?.close === "edit") {
      closeEditModal();
    }
  });

  ui.editForm.addEventListener("submit", submitEditForm);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    if (!ui.trailerModal.classList.contains("hidden")) {
      closeTrailerModal();
    }

    if (!ui.editModal.classList.contains("hidden")) {
      closeEditModal();
    }
  });
}

async function boot() {
  wireEvents();

  try {
    await loadMovies();
  } catch (error) {
    setStatus(`Could not load movies: ${error.message}`);
  }
}

boot();
