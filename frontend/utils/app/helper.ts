const getURLQueryParam = ({ param = '' }) => {
  // SSR guard: window is not available during server-side rendering
  if (typeof window === 'undefined') return param ? null : {};
  const urlParams = new URLSearchParams(window.location.search);

  if (param) {
    // Get the value of a specific query parameter
    return urlParams.get(param);
  } else {
    // Get all query params safely
    const paramsObject = Object.create(null); // Prevent prototype pollution
    for (const [key, value] of Array.from(urlParams?.entries())) {
      if (Object.prototype.hasOwnProperty.call(paramsObject, key)) continue; // Extra safety check
      paramsObject[key] = value;
    }
    return paramsObject;
  }
};

export const getWorkflowName = () => {
  const workflow =
    getURLQueryParam({ param: 'workflow' }) ||
    process?.env?.NEXT_PUBLIC_WORKFLOW ||
    'Daedalus';
  return workflow;
};
