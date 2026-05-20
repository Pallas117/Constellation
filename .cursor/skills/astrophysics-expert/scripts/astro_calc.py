#!/usr/bin/env python3
"""Astrophysics helper calculator for common deterministic computations."""

import argparse
import math
from typing import Tuple

C = 2.99792458e8
G = 6.67430e-11
AU_M = 1.495978707e11
PC_M = 3.085677581e16
M_SUN_KG = 1.98847e30


def scientific(value: float, unit: str) -> str:
    return f"{value:.6e} {unit}".strip()


def flux_from_luminosity(luminosity_w: float, distance_m: float) -> float:
    if distance_m <= 0:
        raise ValueError("distance_m must be > 0")
    return luminosity_w / (4.0 * math.pi * distance_m * distance_m)


def luminosity_from_flux(flux_w_m2: float, distance_m: float) -> float:
    if distance_m <= 0:
        raise ValueError("distance_m must be > 0")
    return flux_w_m2 * (4.0 * math.pi * distance_m * distance_m)


def distance_modulus_to_parsec(mu: float) -> float:
    return 10.0 ** ((mu + 5.0) / 5.0)


def parsec_to_distance_modulus(distance_pc: float) -> float:
    if distance_pc <= 0:
        raise ValueError("distance_pc must be > 0")
    return 5.0 * math.log10(distance_pc / 10.0)


def schwarzschild_radius(mass_kg: float) -> float:
    if mass_kg <= 0:
        raise ValueError("mass_kg must be > 0")
    return (2.0 * G * mass_kg) / (C * C)


def kepler_period(semi_major_axis_au: float, total_mass_solar: float) -> Tuple[float, float]:
    if semi_major_axis_au <= 0:
        raise ValueError("semi_major_axis_au must be > 0")
    if total_mass_solar <= 0:
        raise ValueError("total_mass_solar must be > 0")
    period_years = math.sqrt((semi_major_axis_au ** 3) / total_mass_solar)
    period_seconds = period_years * 365.25 * 24.0 * 3600.0
    return period_years, period_seconds


def escape_velocity(mass_kg: float, radius_m: float) -> float:
    if mass_kg <= 0:
        raise ValueError("mass_kg must be > 0")
    if radius_m <= 0:
        raise ValueError("radius_m must be > 0")
    return math.sqrt((2.0 * G * mass_kg) / radius_m)


def low_z_velocity(z: float) -> float:
    if z < 0:
        raise ValueError("z must be >= 0")
    return z * C


def add_flux_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("flux", help="Compute flux from luminosity and distance")
    parser.add_argument("--luminosity-w", type=float, required=True)
    parser.add_argument("--distance-m", type=float, required=True)


def add_luminosity_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("luminosity", help="Compute luminosity from flux and distance")
    parser.add_argument("--flux-w-m2", type=float, required=True)
    parser.add_argument("--distance-m", type=float, required=True)


def add_mu_to_pc_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("mu-to-pc", help="Convert distance modulus to parsec")
    parser.add_argument("--mu", type=float, required=True)


def add_pc_to_mu_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("pc-to-mu", help="Convert parsec to distance modulus")
    parser.add_argument("--distance-pc", type=float, required=True)


def add_schwarzschild_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "schwarzschild-radius",
        help="Compute Schwarzschild radius from mass",
    )
    parser.add_argument("--mass-kg", type=float)
    parser.add_argument("--mass-solar", type=float)


def add_kepler_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("kepler-period", help="Compute Keplerian period")
    parser.add_argument("--semi-major-axis-au", type=float, required=True)
    parser.add_argument("--total-mass-solar", type=float, required=True)


def add_escape_velocity_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("escape-velocity", help="Compute escape velocity")
    parser.add_argument("--mass-kg", type=float, required=True)
    parser.add_argument("--radius-m", type=float, required=True)


def add_low_z_velocity_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("low-z-velocity", help="Compute v~cz in low-redshift regime")
    parser.add_argument("--z", type=float, required=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Astrophysics deterministic calculator")
    subparsers = parser.add_subparsers(dest="command", required=True)

    add_flux_parser(subparsers)
    add_luminosity_parser(subparsers)
    add_mu_to_pc_parser(subparsers)
    add_pc_to_mu_parser(subparsers)
    add_schwarzschild_parser(subparsers)
    add_kepler_parser(subparsers)
    add_escape_velocity_parser(subparsers)
    add_low_z_velocity_parser(subparsers)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "flux":
            result = flux_from_luminosity(args.luminosity_w, args.distance_m)
            print(scientific(result, "W m^-2"))
        elif args.command == "luminosity":
            result = luminosity_from_flux(args.flux_w_m2, args.distance_m)
            print(scientific(result, "W"))
        elif args.command == "mu-to-pc":
            result = distance_modulus_to_parsec(args.mu)
            print(scientific(result, "pc"))
        elif args.command == "pc-to-mu":
            result = parsec_to_distance_modulus(args.distance_pc)
            print(f"{result:.6f}")
        elif args.command == "schwarzschild-radius":
            mass_kg = args.mass_kg
            if args.mass_solar is not None:
                mass_kg = args.mass_solar * M_SUN_KG
            if mass_kg is None:
                raise ValueError("provide --mass-kg or --mass-solar")
            result = schwarzschild_radius(mass_kg)
            print(scientific(result, "m"))
        elif args.command == "kepler-period":
            years, seconds = kepler_period(args.semi_major_axis_au, args.total_mass_solar)
            print(f"{years:.6f} yr")
            print(scientific(seconds, "s"))
        elif args.command == "escape-velocity":
            result = escape_velocity(args.mass_kg, args.radius_m)
            print(scientific(result, "m s^-1"))
        elif args.command == "low-z-velocity":
            if args.z > 0.1:
                print("warning: z > 0.1; v=cz is only a low-z approximation")
            result = low_z_velocity(args.z)
            print(scientific(result, "m s^-1"))
        else:
            parser.error("unknown command")
    except ValueError as error:
        parser.error(str(error))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
