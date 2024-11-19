const _get = require("lodash/get");
const _isEqual = require("lodash/isEqual");
const _isEmpty = require("lodash/isEmpty");
const { getPasswordFromUserModel, getUserWithPhone } = require("../../model");

const userWithPhoneExistsResolver = async (_obj, args) => {
  const { data } = args;
  const { phone } = data;

  try {
    const rows = await getUserWithPhone(phone);
    return !_isEmpty(rows, "0", {});
  } catch (e) {
    return false;
  }
};

const verifyPasswordResolver = async (_obj, args) => {
  const { data } = args;

  const { phone, password } = data;
  try {
    const rows = await getPasswordFromUserModel(phone);
    if (_isEqual(password, _get(rows, "[0].password", null))) {
      return { message: "Success", status: true };
    }

    return { message: "Please enter the correct password.", status: false };
  } catch (e) {
    return { message: "Internal server error", status: false };
  }
};

module.exports = { verifyPasswordResolver, userWithPhoneExistsResolver };
