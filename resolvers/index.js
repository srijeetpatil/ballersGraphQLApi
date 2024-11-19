const { getDataFromDB } = require("../model");
const { createUserResolver } = require("./MutationResolvers");
const {
  verifyPasswordResolver,
  userWithPhoneExistsResolver,
} = require("./QueryResolvers");

const resolvers = {
  Query: {
    warriors: (obj, args, context, info) => {
      getDataFromDB().then((resp) => {
        console.log(resp);
      });
      return context.warriors;
    },
    verifyPasswordForPhone: verifyPasswordResolver,
    userWithPhoneExists: userWithPhoneExistsResolver,
  },
  Mutation: {
    createUser: createUserResolver,
  },
};

module.exports = resolvers;
