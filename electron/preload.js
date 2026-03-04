const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flexDesktop", {
  platform: "desktop",
  runtime: "electron",
  selectMoviesDirectory: async () => ipcRenderer.invoke("flexflix:select-movies-directory")
});