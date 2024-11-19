const { buildSchema } = require("graphql");

const schema = buildSchema(`
  type Warrior {
    id: ID!
    username: String!
  }

  type User {
    id: ID!
    username: String!
    phone: String!
    position: String!
  }

  type Confirmation {
    message: String!
    status: Boolean
  }

  scalar Phone

  input phoneInput {
    phone: Phone
  }

  input createUserInput {
    username: String!
    phone: String!
    position: String!
    password: String!
  }

  input VerifyPasswordInput {
    phone: String!
    password: String!
  }
  
  type Query {
    warriors: [Warrior]
    verifyPasswordForPhone(data: VerifyPasswordInput!): Confirmation
    userWithPhoneExists(data: phoneInput!): Boolean!
  }

  type Mutation {
    createUser(data: createUserInput!): Confirmation
  }
`);

module.exports = schema;
