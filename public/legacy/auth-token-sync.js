(function () {
  var PRIMARY_KEY = "operator_token";
  var COMPAT_KEY = "cq_admin_token";
  var originalSetItem = sessionStorage.setItem.bind(sessionStorage);
  var originalRemoveItem = sessionStorage.removeItem.bind(sessionStorage);
  var originalClear = sessionStorage.clear.bind(sessionStorage);

  sessionStorage.setItem = function (key, value) {
    originalSetItem(key, value);
    if (key === PRIMARY_KEY) {
      originalSetItem(COMPAT_KEY, value);
    } else if (key === COMPAT_KEY) {
      originalSetItem(PRIMARY_KEY, value);
    }
  };

  sessionStorage.removeItem = function (key) {
    originalRemoveItem(key);
    if (key === PRIMARY_KEY) {
      originalRemoveItem(COMPAT_KEY);
    } else if (key === COMPAT_KEY) {
      originalRemoveItem(PRIMARY_KEY);
    }
  };

  sessionStorage.clear = function () {
    originalClear();
  };

  var existingToken = sessionStorage.getItem(PRIMARY_KEY) || sessionStorage.getItem(COMPAT_KEY);
  if (existingToken) {
    originalSetItem(PRIMARY_KEY, existingToken);
    originalSetItem(COMPAT_KEY, existingToken);
  }
})();
