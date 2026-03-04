const EDITABLE_FIELDS = ["title", "releaseYear", "rated", "description", "genre", "language", "country", "poster", "trailerLink", "tag"];

const TAG_OPTIONS = [
  "Drama",
  "Coming-of-age",
  "Gay",
  "Romance",
  "Romantic Comedy (Rom-Com)",
  "Family",
  "Comedy",
  "Dark Comedy",
  "Action",
  "Adventure",
  "War",
  "Disaster",
  "Horror",
  "Psychological Horror",
  "Slasher",
  "Supernatural",
  "Monster",
  "Vampire",
  "Zombie",
  "Thriller",
  "Psychological Thriller",
  "Crime Thriller",
  "Mystery",
  "Science Fiction (Sci-Fi)",
  "Time Travel",
  "Fantasy",
  "Crime",
  "Detective",
  "Gangster",
  "Legal Drama",
  "Historical",
  "Period Drama",
  "Biographical (Biopic)",
  "Musical",
  "Dance",
  "Teen",
  "Documentary",
  "Docudrama",
  "Concert Film"
];

const state = {
  movies: [],
  filteredMovies: [],
  featuredMovieId: null,
  editingMovieId: null,
  activeTrailerToken: null,
  currentUser: null,
  authMode: "register",
  pendingAvatarDataUrl: null,
  settings: {
    moviesDir: "",
    parentalLock: false
  }
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
  settingsButton: document.getElementById("settingsButton"),
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
  editTagSelect: document.getElementById("editTagSelect"),
  cancelEditButton: document.getElementById("cancelEditButton"),
  saveEditButton: document.getElementById("saveEditButton"),
  settingsModal: document.getElementById("settingsModal"),
  closeSettingsModal: document.getElementById("closeSettingsModal"),
  settingsForm: document.getElementById("settingsForm"),
  settingsMoviesDir: document.getElementById("settingsMoviesDir"),
  browseMoviesDirButton: document.getElementById("browseMoviesDirButton"),
  settingsParentalLockOn: document.getElementById("settingsParentalLockOn"),
  settingsParentalLockOff: document.getElementById("settingsParentalLockOff"),
  cancelSettingsButton: document.getElementById("cancelSettingsButton"),
  saveSettingsButton: document.getElementById("saveSettingsButton"),
  settingsHint: document.getElementById("settingsHint"),
  authGate: document.getElementById("authGate"),
  authForm: document.getElementById("authForm"),
  authModeRegister: document.getElementById("authModeRegister"),
  authModeLogin: document.getElementById("authModeLogin"),
  authMessage: document.getElementById("authMessage"),
  authDisplayNameField: document.getElementById("authDisplayNameField"),
  authDisplayImageField: document.getElementById("authDisplayImageField"),
  authDisplayName: document.getElementById("authDisplayName"),
  authDisplayImage: document.getElementById("authDisplayImage"),
  authDisplayImageFileField: document.getElementById("authDisplayImageFileField"),
  authDisplayImageFile: document.getElementById("authDisplayImageFile"),
  authPassword: document.getElementById("authPassword"),
  authSubmitButton: document.getElementById("authSubmitButton"),
  activeUser: document.getElementById("activeUser"),
  activeUserAvatarImage: document.getElementById("activeUserAvatarImage"),
  activeUserAvatarFallback: document.getElementById("activeUserAvatarFallback"),
  activeUserName: document.getElementById("activeUserName"),
  activeUserEmail: document.getElementById("activeUserEmail"),
  logoutButton: document.getElementById("logoutButton")
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

function pickRandomMovieId(movies) {
  if (!Array.isArray(movies) || !movies.length) {
    return null;
  }

  const randomIndex = Math.floor(Math.random() * movies.length);
  return movies[randomIndex]?.id || null;
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

function normalizeTagList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }

  const textValue = String(value || "").trim();
  if (!textValue) {
    return [];
  }

  return [...new Set(textValue.split(",").map((item) => item.trim()).filter(Boolean))];
}

function populateTagOptions() {
  if (!ui.editTagSelect) {
    return;
  }

  if (ui.editTagSelect.options.length) {
    return;
  }

  for (const optionValue of TAG_OPTIONS) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionValue;
    ui.editTagSelect.append(option);
  }
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

function setAuthMessage(text, isError = false) {
  ui.authMessage.textContent = text || "";
  ui.authMessage.classList.toggle("is-error", Boolean(isError));
}

function setAuthMode(mode, options = {}) {
  const normalizedMode = mode === "login" ? "login" : "register";
  state.authMode = normalizedMode;

  const registerMode = normalizedMode === "register";
  ui.authModeRegister.classList.toggle("is-active", registerMode);
  ui.authModeRegister.setAttribute("aria-selected", registerMode ? "true" : "false");

  ui.authModeLogin.classList.toggle("is-active", !registerMode);
  ui.authModeLogin.setAttribute("aria-selected", !registerMode ? "true" : "false");

  ui.authDisplayNameField.classList.toggle("hidden", !registerMode);
  ui.authDisplayImageField.classList.toggle("hidden", !registerMode);
  ui.authDisplayImageFileField.classList.toggle("hidden", !registerMode);
  ui.authSubmitButton.textContent = registerMode ? "Create Profile" : "Sign In";

  ui.authPassword.autocomplete = registerMode ? "new-password" : "current-password";

  if (!registerMode) {
    state.pendingAvatarDataUrl = null;
    ui.authDisplayImageFile.value = "";
  }

  if (!options.keepMessage) {
    setAuthMessage(registerMode ? "Create your profile to unlock your library." : "Sign in with your registered email and password.");
  }
}

function setSettingsHint(text, isError = false) {
  ui.settingsHint.textContent = text || "";
  ui.settingsHint.classList.toggle("is-error", Boolean(isError));
}

async function loadSettings() {
  const payload = await fetchJson("/api/settings");
  state.settings.moviesDir = String(payload.moviesDir || "").trim();
  state.settings.parentalLock = Boolean(payload.parentalLock);
  return payload;
}

function openSettingsModal() {
  ui.settingsMoviesDir.value = state.settings.moviesDir || "";
  ui.settingsParentalLockOn.checked = Boolean(state.settings.parentalLock);
  ui.settingsParentalLockOff.checked = !state.settings.parentalLock;
  setSettingsHint("Select the folder and parental-lock preference for your library.");
  openModal(ui.settingsModal);
}

function closeSettingsModal() {
  setSettingsHint("");
  closeModal(ui.settingsModal);
}

async function browseForMoviesDirectory() {
  if (!window.flexDesktop || typeof window.flexDesktop.selectMoviesDirectory !== "function") {
    setSettingsHint("Folder picker is available in the desktop app build.", true);
    return;
  }

  try {
    const result = await window.flexDesktop.selectMoviesDirectory();
    if (!result || result.canceled || !result.folderPath) {
      return;
    }

    ui.settingsMoviesDir.value = result.folderPath;
    setSettingsHint("Selected folder: " + result.folderPath);
  } catch (error) {
    setSettingsHint("Could not open folder picker: " + error.message, true);
  }
}

async function submitSettingsForm(event) {
  event.preventDefault();

  const nextMoviesDir = String(ui.settingsMoviesDir.value || "").trim();
  if (!nextMoviesDir) {
    setSettingsHint("Please select a valid folder path.", true);
    return;
  }

  const nextParentalLock = Boolean(ui.settingsParentalLockOn.checked);

  ui.saveSettingsButton.disabled = true;
  ui.saveSettingsButton.textContent = "Saving...";
  ui.browseMoviesDirButton.disabled = true;

  try {
    const result = await fetchJson("/api/settings/movies-dir", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        moviesDir: nextMoviesDir,
        parentalLock: nextParentalLock
      })
    });

    state.settings.moviesDir = String(result.moviesDir || nextMoviesDir).trim();
    state.settings.parentalLock = Boolean(result.parentalLock);
    closeSettingsModal();

    await loadMovies({
      preserveSearch: true,
      preserveFeaturedId: state.featuredMovieId
    });

    const lockStatus = state.settings.parentalLock ? "On (G/U/PG-13 only)" : "Off";
    setStatus("Settings saved. Folder: " + state.settings.moviesDir + " | Parental Lock: " + lockStatus + ".");
  } catch (error) {
    if (error.status === 401) {
      closeSettingsModal();
      await requireReAuth("Session expired. Sign in to continue.");
      return;
    }

    setSettingsHint(error.message, true);
  } finally {
    ui.saveSettingsButton.disabled = false;
    ui.saveSettingsButton.textContent = "Save Settings";
    ui.browseMoviesDirButton.disabled = false;
  }
}

function openModal(modalElement) {
  modalElement.classList.remove("hidden");
  modalElement.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeModal(modalElement) {
  modalElement.classList.add("hidden");
  modalElement.setAttribute("aria-hidden", "true");

  if (
    ui.trailerModal.classList.contains("hidden") &&
    ui.editModal.classList.contains("hidden") &&
    ui.settingsModal.classList.contains("hidden")
  ) {
    document.body.classList.remove("modal-open");
  }
}

function showAuthGate(mode = "register") {
  setAuthMode(mode);
  ui.authGate.classList.remove("hidden");
  ui.authGate.setAttribute("aria-hidden", "false");
  document.body.classList.add("auth-locked");
}

function hideAuthGate() {
  ui.authGate.classList.add("hidden");
  ui.authGate.setAttribute("aria-hidden", "true");
  document.body.classList.remove("auth-locked");
  setAuthMessage("");
  state.pendingAvatarDataUrl = null;
  ui.authForm.reset();
}

function getUserInitials(user) {
  const base = String(user?.displayName || user?.email || "U")
    .trim()
    .replace(/\s+/g, " ");

  if (!base) {
    return "U";
  }

  const parts = base.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  return base.slice(0, 2).toUpperCase();
}

function renderActiveUser() {
  const user = state.currentUser;

  if (!user) {
    ui.activeUser.classList.add("hidden");
    ui.activeUserAvatarImage.src = "";
    ui.activeUserAvatarImage.classList.add("hidden");
    ui.activeUserAvatarFallback.textContent = "";
    ui.settingsButton.classList.add("hidden");
    return;
  }

  ui.activeUser.classList.remove("hidden");
  ui.settingsButton.classList.remove("hidden");
  ui.activeUserName.textContent = user.displayName || user.email;
  ui.activeUserEmail.textContent = user.email || "";
  ui.activeUserAvatarFallback.textContent = getUserInitials(user);

  const image = String(user.displayImage || "").trim();
  if (image) {
    ui.activeUserAvatarImage.src = image;
    ui.activeUserAvatarImage.classList.remove("hidden");
    return;
  }

  ui.activeUserAvatarImage.src = "";
  ui.activeUserAvatarImage.classList.add("hidden");
}

function clearLibraryState() {
  state.movies = [];
  state.filteredMovies = [];
  state.featuredMovieId = null;
  state.editingMovieId = null;
  state.activeTrailerToken = null;

  ui.movieGrid.innerHTML = "";
  ui.heroSection.classList.add("hidden");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error || "Request failed");
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function requireReAuth(message) {
  closeTrailerModal();
  closeEditModal();
  closeSettingsModal();

  state.currentUser = null;
  renderActiveUser();
  clearLibraryState();
  showAuthGate("login");

  setStatus(message || "Please sign in to continue.");
  setAuthMessage(message || "Your session ended. Sign in again.", true);
}

async function syncAuthSession() {
  try {
    const payload = await fetchJson("/api/auth/session");

    if (payload.authenticated && payload.user) {
      state.currentUser = payload.user;
      hideAuthGate();
      renderActiveUser();

      try {
        await loadSettings();
      } catch (settingsError) {
        setStatus("Could not load settings: " + settingsError.message);
      }

      return true;
    }

    state.currentUser = null;
    renderActiveUser();
    clearLibraryState();

    if (payload.hasRegisteredUsers) {
      showAuthGate("login");
      setStatus("Sign in to view your local movies.");
    } else {
      showAuthGate("register");
      setStatus("Create your first profile to start using FlexFlix.");
    }

    return false;
  } catch (error) {
    showAuthGate("register");
    setStatus(`Could not initialize authentication: ${error.message}`);
    setAuthMessage(`Could not initialize authentication: ${error.message}`, true);
    return false;
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

    if (error.status === 401) {
      closeTrailerModal();
      await requireReAuth("Session expired. Sign in to continue.");
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
  ui.editModalTitle.textContent = "Edit Details: " + movie.title;

  populateTagOptions();

  for (const field of EDITABLE_FIELDS) {
    const input = ui.editForm.elements.namedItem(field);
    if (!input) {
      continue;
    }

    const value = movie[field];

    if (field === "tag") {
      const selectedTags = normalizeTagList(value);
      const selectedSet = new Set(selectedTags);

      for (const option of ui.editTagSelect.options) {
        option.selected = selectedSet.has(option.value);
      }

      continue;
    }

    input.value = isDefaultOrMissingValue(field, value) ? "" : String(value || "");
  }

  openModal(ui.editModal);
}

function closeEditModal() {
  state.editingMovieId = null;
  ui.editForm.reset();

  if (ui.editTagSelect) {
    for (const option of ui.editTagSelect.options) {
      option.selected = false;
    }
  }

  closeModal(ui.editModal);
}

async function playMovie(movieId) {
  return fetchJson("/api/play", {
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
      setStatus(`Playing ${movie.title} in VLC player.`);
    } catch (error) {
      if (error.status === 401) {
        await requireReAuth("Session expired. Sign in to continue.");
        return;
      }

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
      setStatus(`Playing ${movie.title} in VLC player.`);
    } catch (error) {
      if (error.status === 401) {
        await requireReAuth("Session expired. Sign in to continue.");
        return;
      }

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

  let payload;
  try {
    payload = await fetchJson("/api/movies");
  } catch (error) {
    if (error.status === 401) {
      await requireReAuth("Session expired. Sign in to continue.");
      return;
    }

    throw error;
  }

  state.movies = payload.movies || [];

  if (previousFeaturedId && getMovieById(previousFeaturedId)) {
    state.featuredMovieId = previousFeaturedId;
  } else if (!getMovieById(state.featuredMovieId)) {
    state.featuredMovieId = pickRandomMovieId(state.movies);
  }

  state.filteredMovies = [...state.movies];
  renderFeaturedMovie();
  renderMovieGrid();

  const timestamp = payload.lastScan ? new Date(payload.lastScan).toLocaleString() : "N/A";
  const lockText = payload.parentalLock ? " Parental Lock: On (G/U/PG-13 only)." : "";
  setStatus(`Loaded ${state.movies.length} movies from ${payload.sourceDir || "unknown folder"}. Last scan: ${timestamp}.` + lockText);

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
    if (error.status === 401) {
      await requireReAuth("Session expired. Sign in to continue.");
      return;
    }

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
    if (field === "tag") {
      payload[field] = formData.getAll(field);
      continue;
    }

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
    if (error.status === 401) {
      await requireReAuth("Session expired. Sign in to continue.");
      return;
    }

    setStatus(`Could not save changes: ${error.message}`);
  } finally {
    ui.saveEditButton.disabled = false;
    ui.saveEditButton.textContent = "Save Changes";
  }
}

function readImageFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read selected image file."));
    reader.readAsDataURL(file);
  });
}

async function handleAuthImageFileChange() {
  const file = ui.authDisplayImageFile.files?.[0];

  if (!file) {
    state.pendingAvatarDataUrl = null;
    return;
  }

  if (!file.type.startsWith("image/")) {
    state.pendingAvatarDataUrl = null;
    ui.authDisplayImageFile.value = "";
    setAuthMessage("Please choose a valid image file.", true);
    return;
  }

  if (file.size > 1_500_000) {
    state.pendingAvatarDataUrl = null;
    ui.authDisplayImageFile.value = "";
    setAuthMessage("Image is too large. Use an image under 1.5MB.", true);
    return;
  }

  try {
    const dataUrl = await readImageFileAsDataUrl(file);
    state.pendingAvatarDataUrl = dataUrl;
    setAuthMessage("Profile image selected from file.");
  } catch (error) {
    state.pendingAvatarDataUrl = null;
    ui.authDisplayImageFile.value = "";
    setAuthMessage(error.message, true);
  }
}

async function submitAuthForm(event) {
  event.preventDefault();

  const formData = new FormData(ui.authForm);
  const payload = {
    email: String(formData.get("email") || "").trim(),
    password: String(formData.get("password") || "")
  };

  if (state.authMode === "register") {
    payload.displayName = String(formData.get("displayName") || "").trim();

    const imageFromUrl = String(formData.get("displayImage") || "").trim();
    payload.displayImage = imageFromUrl || state.pendingAvatarDataUrl;
  }

  const endpoint = state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
  const buttonLabel = state.authMode === "register" ? "Create Profile" : "Sign In";

  ui.authSubmitButton.disabled = true;
  ui.authSubmitButton.textContent = state.authMode === "register" ? "Creating..." : "Signing in...";

  try {
    const result = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    state.currentUser = result.user || null;
    renderActiveUser();
    hideAuthGate();

    await loadSettings();
    await loadMovies();
    setStatus(`Welcome ${state.currentUser?.displayName || state.currentUser?.email || ""}.`);
  } catch (error) {
    setAuthMessage(error.message, true);
  } finally {
    ui.authSubmitButton.disabled = false;
    ui.authSubmitButton.textContent = buttonLabel;
  }
}

async function logout() {
  ui.logoutButton.disabled = true;

  try {
    await fetchJson("/api/auth/logout", {
      method: "POST"
    });

    closeTrailerModal();
    closeEditModal();
    closeSettingsModal();

    state.currentUser = null;
    renderActiveUser();
    clearLibraryState();

    showAuthGate("login");
    setStatus("Signed out. Sign back in to continue.");
  } catch (error) {
    setStatus(`Could not sign out: ${error.message}`);
  } finally {
    ui.logoutButton.disabled = false;
  }
}

function wireEvents() {
  ui.searchInput.addEventListener("input", applySearch);
  ui.rescanButton.addEventListener("click", () => {
    void rescanMovies();
  });

  ui.settingsButton.addEventListener("click", () => {
    openSettingsModal();
  });

  ui.closeSettingsModal.addEventListener("click", closeSettingsModal);
  ui.cancelSettingsButton.addEventListener("click", closeSettingsModal);
  ui.settingsModal.addEventListener("click", (event) => {
    if (event.target?.dataset?.close === "settings") {
      closeSettingsModal();
    }
  });

  ui.browseMoviesDirButton.addEventListener("click", () => {
    void browseForMoviesDirectory();
  });

  ui.settingsForm.addEventListener("submit", submitSettingsForm);

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

  ui.authModeRegister.addEventListener("click", () => {
    setAuthMode("register");
  });

  ui.authModeLogin.addEventListener("click", () => {
    setAuthMode("login");
  });

  ui.authForm.addEventListener("submit", submitAuthForm);
  ui.authDisplayImageFile.addEventListener("change", () => {
    void handleAuthImageFileChange();
  });

  ui.logoutButton.addEventListener("click", () => {
    void logout();
  });

  ui.activeUserAvatarImage.addEventListener("error", () => {
    ui.activeUserAvatarImage.src = "";
    ui.activeUserAvatarImage.classList.add("hidden");
  });

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

    if (!ui.settingsModal.classList.contains("hidden")) {
      closeSettingsModal();
    }
  });
}

async function boot() {
  populateTagOptions();
  wireEvents();

  const authenticated = await syncAuthSession();
  if (!authenticated) {
    return;
  }

  try {
    await loadMovies();
  } catch (error) {
    setStatus(`Could not load movies: ${error.message}`);
  }
}

boot();
