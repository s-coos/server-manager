import express from "express";

console.log("starting");

const app = express();
const PORT = Number(process.env.PORT ?? "") || 4000;

app.get("/health", (_req, res) => {
  res.sendStatus(200);
});

app.get("/log/:message", (req, res) => {
  console.log(`02-restore: ${req.params.message}`);
  res.sendStatus(200);
});

app.post("/server-manager/prepare-to-be-active", (_req, res) => {
  res.sendStatus(200);
});

app.post("/server-manager/prepare-to-be-non-active", (_req, res) => {
  res.sendStatus(200);
});

app.post("/server-manager/activated", (_req, res) => {
  res.sendStatus(200);
});

app.post("/server-manager/deactivated", (_req, res) => {
  res.sendStatus(200);
});

app.post("/server-manager/cancel-prepare-to-be-active", (_req, res) => {
  res.sendStatus(200);
});

app.post("/server-manager/cancel-prepare-to-be-non-active", (_req, res) => {
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("started");
});
