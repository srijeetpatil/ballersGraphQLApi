const express = require("express");
const cors = require("cors");
const { graphqlHTTP } = require("express-graphql");
const { makeExecutableSchema } = require("@graphql-tools/schema");

const schema = require("./schema");
const resolvers = require("./resolvers");

const data = {
  warriors: [
    { id: "001", username: "Jaime" },
    { id: "002", username: "Jorah" },
  ],
};

const executableSchema = makeExecutableSchema({
  typeDefs: schema,
  resolvers,
});

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  "/graphql",
  graphqlHTTP({
    schema: executableSchema,
    context: data,
    graphiql: true,
  })
);

app.get("/", (request, response) => {
  response.send("Hello, GraphQL!");
});

app.listen(port, () => {
  console.log(`Running a server at http://localhost:${port}`);
});
