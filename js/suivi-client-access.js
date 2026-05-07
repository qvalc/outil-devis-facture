// BastCompta - contrôle d’accès Suivi client

(function () {
      const PORTAL_URL = 'index.html';
      const ACCESS_KEY = 'bastcompta_portal_access';

      let hasPortalAccess = false;
      try {
        hasPortalAccess = sessionStorage.getItem(ACCESS_KEY) === 'granted';
      } catch (error) {
        hasPortalAccess = false;
      }

      if (window.top === window.self || !hasPortalAccess) {
        window.location.replace(PORTAL_URL);
      }
    })();
