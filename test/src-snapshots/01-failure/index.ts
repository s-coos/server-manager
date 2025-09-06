import express from "express";

console.log("starting");

const app = express();
const PORT = Number(process.env.PORT ?? "") || 4000;

app.get("/health", (_req, res) => {
  res.sendStatus(500);
});

app.get("/log/:message", (req, res) => {
  console.log(`01-failure: ${req.params.message}`);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("started");
});
