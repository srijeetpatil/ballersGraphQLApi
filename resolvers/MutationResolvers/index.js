const { createUserModel } = require("../../model");
// const { v4: uuidv4 } = require("uuid");

const createUserResolver = async (obj, args, context, info) => {
  const { data } = args;

  //   const userId = uuidv4();
  const { username, phone, position, password } = data;
  try {
    await createUserModel(username, phone, position, password);
    return { message: "Success" };
  } catch (e) {
    return { message: "Error" };
  }
};

module.exports = {
  createUserResolver,
};
