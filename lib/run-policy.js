function allowPaidProviders(options) {
  return !(options && options.dryRun);
}

module.exports = {
  allowPaidProviders: allowPaidProviders
};
