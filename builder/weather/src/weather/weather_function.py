import logging
import os
from dataclasses import dataclass

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.geolocation import GeolocationResult
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class CurrentWeather(BaseModel):
    """Current weather conditions."""

    temperature: float = Field(description="Current temperature in Fahrenheit")
    relative_humidity: float | None = Field(
        None, description="Current relative humidity in %"
    )
    wind_speed: float = Field(description="Current wind speed in mph")
    weather_code: int | None = Field(None, description="Weather condition code")
    is_day: bool | None = Field(None, description="Whether it's day or night")
    precipitation_probability: float | None = Field(
        None, description="Current precipitation probability in %"
    )


class HourlyWeather(BaseModel):
    """Hourly weather forecast."""

    time: list[str] = Field(default_factory=list, description="Hourly timestamps")
    temperature: list[float] = Field(
        default_factory=list, description="Hourly temperatures in Fahrenheit"
    )
    relative_humidity: list[float] = Field(
        default_factory=list, description="Hourly relative humidity in %"
    )
    wind_speed: list[float] = Field(
        default_factory=list, description="Hourly wind speed in mph"
    )
    weather_code: list[int] = Field(
        default_factory=list, description="Hourly weather condition code"
    )
    is_day: list[bool] = Field(
        default_factory=list, description="Hourly day/night indicator"
    )
    precipitation_probability: list[float] = Field(
        default_factory=list,
        description="Hourly precipitation probability in %",
    )


class WeatherResponseModel(BaseModel):
    """Structured response returned to callers."""

    canonical_name: str = Field(description="Canonical name of the location")
    latitude: float = Field(description="Latitude coordinate")
    longitude: float = Field(description="Longitude coordinate")
    timezone: str = Field(description="Timezone")
    current: CurrentWeather = Field(description="Current weather conditions")
    hourly: HourlyWeather | None = Field(None, description="Hourly weather forecast")
    source: str = Field(
        description="Source of the weather data", default="Open-Meteo API"
    )
    success: bool = Field(default=True, description="Whether the request succeeded")
    fallback_applied: bool = Field(
        default=False,
        description="Whether a configured fallback location was used after geocoding failure",
    )
    geocoding_error: str | None = Field(
        default=None,
        description="Original geocoding error message when fallback was used",
    )


class WeatherFunctionConfig(FunctionBaseConfig, name="weather"):
    """Configuration for the weather workflow."""

    include_hourly: bool = Field(
        default=True,
        description="Include hourly forecast data in the response",
    )
    use_geolocation_retriever: bool = Field(
        default=False,
        description="Use geolocation_retriever for geocoding instead of Open-Meteo geocoding API",
    )
    geolocation_retriever_name: str | None = Field(
        default="geolocation_retriever_tool",
        description="Name of the geolocation retriever to use when use_geolocation_retriever is True",
    )
    geocoding_timeout: float = Field(
        default=30.0,
        ge=1.0,
        le=120.0,
        description="Timeout in seconds for geocoding request",
    )
    weather_timeout: float = Field(
        default=30.0,
        ge=1.0,
        le=120.0,
        description="Timeout in seconds for weather request",
    )
    user_agent: str = Field(
        default="daedalus-weather-agent/1.0",
        description="User-Agent header used for outgoing HTTP requests",
    )
    fallback_location_name: str | None = Field(
        default="Ann Arbor,Michigan,United States",
        description="Display name used when fallback coordinates are applied",
    )
    fallback_latitude: float | None = Field(
        default=42.1667,
        ge=-90.0,
        le=90.0,
        description="Latitude coordinate used when geocoding fails",
    )
    fallback_longitude: float | None = Field(
        default=-83.7816,
        ge=-180.0,
        le=180.0,
        description="Longitude coordinate used when geocoding fails",
    )


@dataclass
class LocationResult:
    """Geocoding result for location lookup."""

    name: str
    latitude: float
    longitude: float
    country: str
    admin1: str | None = None

    @property
    def display_name(self) -> str:
        parts: list[str] = [self.name]
        if self.admin1 and self.admin1 != self.name:
            parts.append(self.admin1)
        if self.country:
            parts.append(self.country)
        return ", ".join(parts)


class WeatherAPIClient:
    """HTTP client responsible for geocoding and weather API calls."""

    def __init__(self, *, user_agent: str, timeout: float) -> None:
        headers = {"User-Agent": user_agent}
        self._client = httpx.AsyncClient(headers=headers, timeout=timeout)
        self.geocoding_url = "https://geocoding-api.open-meteo.com/v1/search"
        self.weather_url = "https://api.open-meteo.com/v1/forecast"

    async def close(self) -> None:
        await self._client.aclose()

    async def geocode_location(
        self, canonical_name: str, timeout: float
    ) -> LocationResult:
        params = {
            "name": canonical_name,
            "count": 10,
            "language": "en",
            "format": "json",
        }
        try:
            response = await self._client.get(
                self.geocoding_url, params=params, timeout=timeout
            )
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPStatusError as exc:
            logger.error("Geocoding HTTP %s: %s", exc.response.status_code, exc)
            raise ConnectionError(
                f"Failed to geocode location: HTTP {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            logger.error("Geocoding request error: %s", exc)
            raise ConnectionError(f"Failed to geocode location: {exc}") from exc

        result = self._extract_best_result(canonical_name, data)
        if result is None:
            raise ValueError(f"Location '{canonical_name}' not found")
        return result

    async def fetch_weather(
        self,
        *,
        latitude: float,
        longitude: float,
        include_hourly: bool,
        timeout: float,
    ) -> dict:
        params: dict = {
            "latitude": latitude,
            "longitude": longitude,
            "current": [
                "temperature_2m",
                "relative_humidity_2m",
                "is_day",
                "weather_code",
                "wind_speed_10m",
            ],
            "timezone": "auto",
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
        }
        if include_hourly:
            params["hourly"] = [
                "temperature_2m",
                "relative_humidity_2m",
                "weather_code",
                "wind_speed_10m",
                "is_day",
                "precipitation_probability",
            ]
            params["forecast_days"] = 2

        try:
            response = await self._client.get(
                self.weather_url, params=params, timeout=timeout
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "Weather HTTP %s: %s", exc.response.status_code, exc.response.text
            )
            raise ConnectionError(
                f"Failed to fetch weather data: HTTP {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            logger.error("Weather request error: %s", exc)
            raise ConnectionError(f"Failed to fetch weather data: {exc}") from exc

    @staticmethod
    def _extract_best_result(
        canonical_name: str, geocoding_data: dict
    ) -> LocationResult | None:
        results = geocoding_data.get("results") or []
        if not results:
            return None

        best = results[0]
        return LocationResult(
            name=best.get("name", canonical_name),
            latitude=best["latitude"],
            longitude=best["longitude"],
            country=best.get("country", ""),
            admin1=best.get("admin1"),
        )


def _build_fallback_location(
    config: WeatherFunctionConfig,
) -> LocationResult | None:
    if config.fallback_latitude is None or config.fallback_longitude is None:
        return None
    name = config.fallback_location_name or "Configured Fallback Location"
    return LocationResult(
        name=name,
        latitude=config.fallback_latitude,
        longitude=config.fallback_longitude,
        country="",
    )


def _parse_current_weather(data: dict) -> CurrentWeather:
    current = data.get("current", {})
    return CurrentWeather(
        temperature=current.get("temperature_2m", 0.0),
        relative_humidity=current.get("relative_humidity_2m"),
        wind_speed=current.get("wind_speed_10m", 0.0),
        weather_code=current.get("weather_code"),
        is_day=current.get("is_day") == 1,
        precipitation_probability=None,
    )


def _parse_hourly_weather(data: dict) -> HourlyWeather | None:
    if "hourly" not in data:
        return None
    hourly = data["hourly"]
    is_day_raw = hourly.get("is_day", [])
    return HourlyWeather(
        time=hourly.get("time", []),
        temperature=hourly.get("temperature_2m", []),
        relative_humidity=hourly.get("relative_humidity_2m", []),
        wind_speed=hourly.get("wind_speed_10m", []),
        weather_code=hourly.get("weather_code", []),
        is_day=[value == 1 for value in is_day_raw],
        precipitation_probability=hourly.get("precipitation_probability", []),
    )


async def _geocode_step(
    *,
    client: WeatherAPIClient,
    canonical_name: str,
    timeout: float,
) -> LocationResult:
    logger.debug("Geocoding location '%s'", canonical_name)
    return await client.geocode_location(canonical_name, timeout)


async def _geocode_with_retriever(
    *,
    geolocation_fn: object,
    canonical_name: str,
) -> LocationResult:
    """
    Geocode using the geolocation_retriever.

    Args:
        geolocation_fn: The geolocation retriever function
        canonical_name: Location string to geocode

    Returns:
        LocationResult with parsed data

    Raises:
        ValueError: If geocoding fails or returns invalid data
    """
    logger.debug("Geocoding location '%s' using geolocation_retriever", canonical_name)

    try:
        # Call the retriever function - try .ainvoke() first, then direct call
        if hasattr(geolocation_fn, "ainvoke"):
            result = await geolocation_fn.ainvoke(canonical_name)
        else:
            result = await geolocation_fn(canonical_name)

        logger.debug("Geolocation retriever raw result: %s", result)

        # Parse the result
        geoloc_result = GeolocationResult.from_retriever_output(result)
        if geoloc_result is None:
            raise ValueError("Failed to parse geolocation_retriever output")

        logger.info(
            "Successfully geocoded '%s' to '%s' (%.4f, %.4f)",
            canonical_name,
            geoloc_result.display_name,
            geoloc_result.latitude,
            geoloc_result.longitude,
        )

        # Convert to LocationResult
        return LocationResult(
            name=geoloc_result.name,
            latitude=geoloc_result.latitude,
            longitude=geoloc_result.longitude,
            country=geoloc_result.country_code or "",
            admin1=None,
        )

    except Exception as exc:
        logger.exception(
            "Geolocation retriever failed for '%s': %s", canonical_name, exc
        )
        raise ValueError(f"Geolocation retriever failed: {exc}") from exc


async def _weather_step(
    *,
    client: WeatherAPIClient,
    location_result: LocationResult,
    include_hourly: bool,
    timeout: float,
    fallback_applied: bool = False,
    geocoding_error: str | None = None,
) -> WeatherResponseModel:
    raw_weather = await client.fetch_weather(
        latitude=location_result.latitude,
        longitude=location_result.longitude,
        include_hourly=include_hourly,
        timeout=timeout,
    )

    current = _parse_current_weather(raw_weather)
    hourly = _parse_hourly_weather(raw_weather) if include_hourly else None

    response = WeatherResponseModel(
        canonical_name=location_result.display_name,
        latitude=location_result.latitude,
        longitude=location_result.longitude,
        timezone=raw_weather.get("timezone", "UTC"),
        current=current,
        hourly=hourly,
        fallback_applied=fallback_applied,
        geocoding_error=geocoding_error,
    )
    logger.debug("Weather response assembled for '%s'", response.canonical_name)
    return response


@register_function(config_type=WeatherFunctionConfig)
async def weather_function(
    config: WeatherFunctionConfig,
    builder: Builder,
):
    """Register the weather workflow with the NAT builder."""

    user_agent = config.user_agent or os.getenv(
        "WEATHER_USER_AGENT", "daedalus-weather-agent/1.0"
    )

    client = WeatherAPIClient(
        user_agent=user_agent,
        timeout=max(config.geocoding_timeout, config.weather_timeout),
    )

    # Debug: Log configuration status - use WARNING so it definitely shows
    logger.warning(
        "🔍 WEATHER INIT: use_geolocation_retriever=%s, retriever_name='%s'",
        config.use_geolocation_retriever,
        config.geolocation_retriever_name,
    )

    async def _weather_workflow(request: dict) -> dict:
        canonical_name = _extract_canonical_name(request)
        coordinates = _extract_coordinates(request)
        include_hourly = _extract_include_hourly(request, config.include_hourly)

        fallback_used = False
        geocoding_error: str | None = None

        # If coordinates are provided directly, skip geocoding
        if coordinates is not None:
            latitude, longitude = coordinates
            # Use coordinates with a generic name if no location name provided
            display_name = (
                canonical_name or f"Location ({latitude:.4f}, {longitude:.4f})"
            )
            location_result = LocationResult(
                name=display_name,
                latitude=latitude,
                longitude=longitude,
                country="",
                admin1=None,
            )
            logger.info(
                "Using provided coordinates: %s (%.4f, %.4f)",
                display_name,
                latitude,
                longitude,
            )
        else:
            # No coordinates provided, must have a location name
            if canonical_name is None:
                raise ValueError(
                    "Missing required location field in request "
                    "(expected one of: location, query, city, input, prompt, message) "
                    "or latitude/longitude coordinates"
                )

            try:
                # Get geolocation retriever lazily (only when needed, after all tools are registered)
                if (
                    config.use_geolocation_retriever
                    and config.geolocation_retriever_name
                ):
                    logger.warning(
                        "🔍 ATTEMPTING to get geolocation_retriever: '%s'",
                        config.geolocation_retriever_name,
                    )
                    try:
                        geolocation_fn = await builder.get_function(
                            config.geolocation_retriever_name
                        )
                        logger.warning(
                            "✅ WEATHER: Successfully got geolocation_retriever '%s' (type: %s)",
                            config.geolocation_retriever_name,
                            type(geolocation_fn).__name__,
                        )
                        logger.info("Using geolocation_retriever for geocoding")
                        location_result = await _geocode_with_retriever(
                            geolocation_fn=geolocation_fn,
                            canonical_name=canonical_name,
                        )
                    except Exception as exc:
                        logger.error(
                            "❌ WEATHER: Failed to get/use geolocation_retriever '%s': %s. "
                            "Falling back to Open-Meteo geocoding.",
                            config.geolocation_retriever_name,
                            exc,
                            exc_info=True,
                        )
                        # Fall back to Open-Meteo
                        logger.info("Using Open-Meteo geocoding (fallback)")
                        location_result = await _geocode_step(
                            client=client,
                            canonical_name=canonical_name,
                            timeout=config.geocoding_timeout,
                        )
                else:
                    logger.warning(
                        "🔍 WEATHER: Geolocation retriever NOT configured, using Open-Meteo geocoding"
                    )
                    logger.info("Using Open-Meteo geocoding")
                    location_result = await _geocode_step(
                        client=client,
                        canonical_name=canonical_name,
                        timeout=config.geocoding_timeout,
                    )
            except Exception as exc:  # noqa: BLE001
                geocoding_error = str(exc)
                logger.error(
                    "Geocoding failed for '%s': %s", canonical_name, geocoding_error
                )
                fallback_location = _build_fallback_location(config)
                if fallback_location is None:
                    logger.exception(
                        "No fallback configured; weather workflow aborting for '%s'",
                        canonical_name,
                    )
                    return {
                        "success": False,
                        "error": geocoding_error,
                        "error_type": exc.__class__.__name__,
                    }
                fallback_used = True
                location_result = fallback_location
                logger.info(
                    "Using fallback location '%s' (%s, %s) for request '%s'",
                    location_result.display_name,
                    location_result.latitude,
                    location_result.longitude,
                    canonical_name,
                )

        try:
            weather_response = await _weather_step(
                client=client,
                location_result=location_result,
                include_hourly=include_hourly,
                timeout=config.weather_timeout,
                fallback_applied=fallback_used,
                geocoding_error=geocoding_error,
            )
            return weather_response.model_dump()
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "Weather workflow failed during forecast fetch for '%s': %s",
                location_result.display_name,
                exc,
            )
            response: dict = {
                "success": False,
                "error": str(exc),
                "error_type": exc.__class__.__name__,
            }
            if fallback_used:
                response["fallback_applied"] = True
                response["geocoding_error"] = geocoding_error
            return response

    try:
        yield FunctionInfo.create(
            single_fn=_weather_workflow,
            description="Fetch current and optional hourly weather data via Open-Meteo.",
        )
    except GeneratorExit:
        logger.warning("Weather workflow exited early")
    finally:
        logger.info("Cleaning up weather workflow client")
        await client.close()


def _extract_canonical_name(request: dict) -> str | None:
    """Extract location name from request. Returns None if coordinates are provided instead."""
    if isinstance(request, dict):
        # Check if coordinates are provided directly
        if "latitude" in request and "longitude" in request:
            return None

        # Check nested request
        nested = request.get("request")
        if isinstance(nested, dict) and "latitude" in nested and "longitude" in nested:
            return None

        # Look for location name in various fields
        candidate_keys = [
            "location",
            "query",
            "city",
            "input",
            "prompt",
            "message",
        ]
        for key in candidate_keys:
            value = request.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        # Check nested request for location name
        if isinstance(nested, dict):
            return _extract_canonical_name(nested)

    if isinstance(request, str) and request.strip():
        return request.strip()

    return None


def _extract_coordinates(request: dict) -> tuple[float, float] | None:
    """Extract latitude and longitude from request. Returns None if not found."""
    if isinstance(request, dict):
        # Check top level
        lat = request.get("latitude")
        lon = request.get("longitude")
        if lat is not None and lon is not None:
            try:
                return float(lat), float(lon)
            except (ValueError, TypeError):
                pass

        # Check nested request
        nested = request.get("request")
        if isinstance(nested, dict):
            return _extract_coordinates(nested)

    return None


def _extract_include_hourly(request: dict, default: bool) -> bool:
    if isinstance(request, dict):
        raw = request.get("include_hourly")
        if isinstance(raw, bool):
            return raw
        nested = request.get("request")
        if isinstance(nested, dict):
            return _extract_include_hourly(nested, default)
    return default
