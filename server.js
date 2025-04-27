const express = require("express");
const cors = require("cors");

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (request, response) => {
  response.send("Hello, GraphQL!");
});

app.listen(port, () => {
  console.log(`Running a server at http://localhost:${port}`);
});
