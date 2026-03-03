const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("flexDesktop", {
  platform: "desktop",
  runtime: "electron"
});
